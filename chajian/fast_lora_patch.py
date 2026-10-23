import logging
import os
import threading
import time
import weakref
from collections import OrderedDict

import torch

import comfy.float
import comfy.lora
import comfy.lora_convert
import comfy.model_management
import comfy.model_patcher
import comfy.sd
import comfy.utils
import folder_paths
from comfy.quant_ops import QuantizedTensor

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_STATES = weakref.WeakKeyDictionary()  # base nn.Module -> _State

_LORA_CACHE = OrderedDict()  # (path, mtime_ns, size) -> dict
_LORA_CACHE_BYTES = 0
_LORA_CACHE_LIMIT = 8 * 1024 ** 3


class _Unsupported(Exception):
    pass


class _State:
    __slots__ = ("key_map", "sd_keys", "backup", "applied", "backup_device")

    def __init__(self):
        self.key_map = None
        self.sd_keys = None
        self.backup = {}
        self.applied = ()
        self.backup_device = None


def _tensor_bytes(value):
    if isinstance(value, torch.Tensor):
        try:
            return value.numel() * value.element_size()
        except Exception:
            return 0
    if isinstance(value, (tuple, list)):
        return sum(_tensor_bytes(v) for v in value)
    if isinstance(value, dict):
        return sum(_tensor_bytes(v) for v in value.values())
    return 0


def _resolve_lora_path(path):
    raw = os.path.expanduser(str(path))
    candidates = [raw]
    if "\\" in raw:
        candidates.append(raw.replace("\\", "/"))
    if "/" in raw:
        candidates.append(raw.replace("/", "\\"))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    for candidate in candidates:
        try:
            full = folder_paths.get_full_path("loras", candidate)
        except Exception:
            full = None
        if full and os.path.isfile(full):
            return os.path.abspath(full)
    raise FileNotFoundError("LoRA file not found: {}".format(path))


def _load_lora_file(path):
    global _LORA_CACHE_BYTES
    full = _resolve_lora_path(path)
    stat = os.stat(full)
    cache_key = (os.path.normcase(full), stat.st_mtime_ns, stat.st_size)
    entry = _LORA_CACHE.get(cache_key)
    if entry is not None:
        _LORA_CACHE.move_to_end(cache_key)
        return entry

    raw = comfy.utils.load_torch_file(full, safe_load=True)
    converted = comfy.lora_convert.convert_lora(raw)
    size = _tensor_bytes(raw)
    entry = {"raw": raw, "converted": converted, "path": full, "bytes": size}
    _LORA_CACHE[cache_key] = entry
    _LORA_CACHE_BYTES += size
    while _LORA_CACHE_BYTES > _LORA_CACHE_LIMIT and len(_LORA_CACHE) > 1:
        _, evicted = _LORA_CACHE.popitem(last=False)
        _LORA_CACHE_BYTES -= evicted["bytes"]
    return entry


def _normalize_stack(stack):
    entries = []

    def walk(items):
        for item in items:
            if isinstance(item, (list, tuple)) and len(item) > 0 and isinstance(item[0], (list, tuple)):
                walk(item)
                continue
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            path = item[0]
            if not isinstance(path, str):
                continue
            strength_model = float(item[1])
            strength_clip = float(item[2]) if len(item) > 2 else strength_model
            entries.append((path, strength_model, strength_clip))

    if isinstance(stack, (list, tuple)) and len(stack) >= 2 and isinstance(stack[0], str):
        stack = [stack]
    if stack:
        walk(stack)
    return entries


def _unpack_key(raw):
    # Flux 的 qkv 用 (模型键, offset[, function]) 元组做键，与 add_patches 保持一致
    if isinstance(raw, str):
        return raw, None, None
    key = raw[0]
    offset = raw[1] if len(raw) > 1 else None
    function = raw[2] if len(raw) > 2 else None
    return key, offset, function


def _patch_has_set(loaded):
    for value in loaded.values():
        if isinstance(value, (tuple, list)) and len(value) == 2 and value[0] == "set":
            return True
    return False


def _get_state(base):
    state = _STATES.get(base)
    if state is None:
        state = _State()
        _STATES[base] = state
    return state


def _get_key_map(state, base, clip):
    if state.key_map is None:
        state.key_map = comfy.lora.model_lora_keys_unet(base, {})
        state.sd_keys = set(base.state_dict().keys())
    key_map = dict(state.key_map)
    if clip is not None:
        key_map = comfy.lora.model_lora_keys_clip(clip.cond_stage_model, key_map)
    return key_map, state.sd_keys


def _collect(stack, state, base, clip):
    key_map, sd_keys = _get_key_map(state, base, clip)
    clip_keys = set(clip.cond_stage_model.state_dict().keys()) if clip is not None else set()

    unet_patches = {}
    clip_entries = []
    signature = []

    for path, strength_model, strength_clip in stack:
        entry = _load_lora_file(path)
        loaded = comfy.lora.load_lora(entry["converted"], key_map, log_missing=False)
        signature.append((entry["path"], strength_model))

        if strength_model != 0.0 or _patch_has_set(loaded):
            for raw_key, patch in loaded.items():
                key, offset, function = _unpack_key(raw_key)
                if key in sd_keys:
                    unet_patches.setdefault(key, []).append(
                        (strength_model, patch, 1.0, offset, function))

        if clip is not None and (strength_clip != 0.0 or _patch_has_set(loaded)):
            if any(_unpack_key(k)[0] in clip_keys for k in loaded):
                clip_entries.append((loaded, strength_clip))

        if not any(_unpack_key(k)[0] in sd_keys for k in loaded) and not any(
                _unpack_key(k)[0] in clip_keys for k in loaded):
            logger.warning("[FastLora] no usable keys matched for %s", entry["path"])

    return unet_patches, clip_entries, tuple(signature)


def _restore_one(base, state, key):
    backup = state.backup.get(key)
    if backup is None:
        return False
    weight, _, _ = comfy.model_patcher.get_key_weight(base, key)
    if weight is None:
        state.backup.pop(key, None)
        return False
    restored = backup.to(device=weight.device, dtype=weight.dtype, copy=True)
    comfy.utils.set_attr_param(base, key, restored)
    state.backup.pop(key, None)
    return True


def _restore_all(base, state):
    if not state.backup:
        return 0
    count = len(state.backup)
    for key in list(state.backup.keys()):
        _restore_one(base, state, key)
    state.applied = ()
    return count


def _patch_one(patcher, base, state, key, patches, compute_dtype, timers):
    weight, set_func, convert_func = comfy.model_patcher.get_key_weight(base, key)
    if weight is None:
        return
    if set_func is not None or isinstance(weight, QuantizedTensor):
        raise _Unsupported("quantized layout op for {}".format(key))

    orig_dtype = weight.dtype
    source = state.backup.get(key)
    if source is None:
        t0 = time.perf_counter()
        target = state.backup_device if state.backup_device is not None else patcher.offload_device
        source = weight.detach().to(device=target, dtype=orig_dtype, copy=True)
        state.backup[key] = source
        timers["backup"] += time.perf_counter() - t0

    t0 = time.perf_counter()
    temp = source.to(device=patcher.load_device, dtype=compute_dtype, copy=True)
    timers["upload"] += time.perf_counter() - t0
    if convert_func is not None:
        temp = convert_func(temp, inplace=True)
    t0 = time.perf_counter()
    out = comfy.lora.calculate_weight(patches, temp, key)
    timers["calc"] += time.perf_counter() - t0
    t0 = time.perf_counter()
    out = comfy.float.stochastic_rounding(out, orig_dtype, seed=comfy.utils.string_to_seed(key))
    timers["round"] += time.perf_counter() - t0
    t0 = time.perf_counter()
    comfy.utils.set_attr_param(base, key, out)
    timers["set"] += time.perf_counter() - t0


def _choose_backup_device(patcher, state, unet_patches, mode, log=False):
    if state.backup_device is not None and state.backup:
        return state.backup_device

    load_device = patcher.load_device
    offload_device = patcher.offload_device
    if mode == "gpu":
        device = load_device
    elif mode == "cpu":
        device = offload_device
    else:
        needed = 0
        for key in unet_patches:
            weight, _, _ = comfy.model_patcher.get_key_weight(patcher.model, key)
            if weight is not None:
                needed += weight.numel() * weight.element_size()
        try:
            free = comfy.model_management.get_free_memory(load_device)
            total = comfy.model_management.get_total_memory(load_device)
        except Exception:
            free, total = 0, 0
        reserve = max(3 * 1024 ** 3, int(total * 0.15))
        device = load_device if needed + reserve <= free else offload_device
        if log:
            logger.info(
                "[FastLora] backup %.2f GB, free %.2f GB, reserve %.2f GB -> %s",
                needed / 1024 ** 3, free / 1024 ** 3, reserve / 1024 ** 3,
                "gpu" if device == load_device else "cpu",
            )

    state.backup_device = device
    return device


def _apply_inplace(patcher, state, unet_patches, signature, log, backup_mode):
    base = patcher.model
    started = time.perf_counter()

    for key in unet_patches:
        weight, _, _ = comfy.model_patcher.get_key_weight(base, key)
        if weight is None or isinstance(weight, QuantizedTensor):
            raise _Unsupported("unsupported weight for {}".format(key))
        if weight.device != patcher.load_device:
            raise _Unsupported("weight not resident on load device: {}".format(key))

    _choose_backup_device(patcher, state, unet_patches, backup_mode, log)

    new_keys = set(unet_patches)
    removed = 0
    for key in list(state.backup.keys()):
        if key not in new_keys:
            _restore_one(base, state, key)
            removed += 1

    compute_dtype = comfy.model_management.lora_compute_dtype(patcher.load_device)
    timers = {"backup": 0.0, "upload": 0.0, "calc": 0.0, "round": 0.0, "set": 0.0}
    for key, patches in unet_patches.items():
        _patch_one(patcher, base, state, key, patches, compute_dtype, timers)

    state.applied = signature
    if log:
        logger.info(
            "[FastLora] in-place patch: %d keys, %d loRA entries, %d restored, backup=%s, %.2fs "
            "(backup %.2f, upload %.2f, calc %.2f, round %.2f, set %.2f)",
            len(unet_patches), len(signature), removed,
            "gpu" if state.backup_device == patcher.load_device else "cpu",
            time.perf_counter() - started,
            timers["backup"], timers["upload"], timers["calc"], timers["round"], timers["set"],
        )


def _can_use_fast_path(patcher):
    if not isinstance(patcher, comfy.model_patcher.ModelPatcher) or patcher.is_dynamic():
        return False, "dynamic VRAM patcher"
    if comfy.model_management.is_device_cpu(patcher.load_device):
        return False, "CPU load device"
    carried = []
    for attr in ("patches", "hook_patches", "weight_wrapper_patches", "object_patches"):
        value = getattr(patcher, attr, None)
        if value:
            carried.append("%s=%d" % (attr, len(value)))
    if carried:
        return False, "patcher already carries state (%s)" % ", ".join(carried)
    if patcher.backup:
        # 其他 LoRA 节点在共享模型上打了补丁但没卸载，这里的备份就是干净权重
        count = len(patcher.backup)
        try:
            patcher.unpatch_model()
        except Exception as exc:
            return False, "unpatch failed: {}".format(exc)
        logger.info("[FastLora] restored %d weights left patched by another patcher", count)

    try:
        comfy.model_management.load_models_gpu([patcher])
    except Exception as exc:
        return False, "load failed: {}".format(exc)

    if patcher.model.model_lowvram or patcher.lowvram_patch_counter() > 0:
        return False, "lowvram / partial load"
    if patcher.current_loaded_device() != patcher.load_device:
        return False, "weights not resident"
    if patcher.model.model_loaded_weight_memory <= 0:
        return False, "model not loaded"
    return True, ""


def _safe_apply(model, clip, stack, log=False):
    for path, strength_model, strength_clip in stack:
        raw = _load_lora_file(path)["raw"]
        model, clip = comfy.sd.load_lora_for_models(model, clip, raw, strength_model, strength_clip)
    if log:
        comfy.model_management.load_models_gpu([model])
        logger.info("[FastLora] safe patch keys=%d", len(model.patches))
    return model, clip


class FastLoraStackPatch:
    NAME = "Apply LoRA Stack (In-Place)"
    CATEGORY = "FastLora"
    DESCRIPTION = (
        "Applies a LORA_STACK by rewiring the resident model weights in place instead of "
        "cloning the patcher and reloading the whole model when strengths change or LoRAs "
        "are added/removed. Fast path needs legacy ModelPatcher (start ComfyUI with "
        "--disable-dynamic-vram); otherwise it falls back to standard clone+patch."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_stack": ("LORA_STACK",),
                "mode": (["fast", "safe", "restore"], {"default": "fast"}),
                "backup": (["auto", "gpu", "cpu"], {"default": "auto"}),
                "log": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "clip": ("CLIP",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "apply"
    OUTPUT_NODE = False

    def apply(self, model, lora_stack, mode, backup, log, clip=None):
        stack = _normalize_stack(lora_stack)

        with _LOCK:
            state = _get_state(model.model)

            if mode == "restore":
                restored = _restore_all(model.model, state)
                if log:
                    logger.info("[FastLora] restore: %d keys", restored)
                return (model, clip)

            if mode == "fast":
                ok, reason = _can_use_fast_path(model)
                if not ok:
                    if log:
                        logger.warning("[FastLora] fast path disabled (%s), using clone+patch", reason)
                    _restore_all(model.model, state)
                    return _safe_apply(model, clip, stack, log)

                try:
                    unet_patches, clip_entries, signature = _collect(stack, state, model.model, clip)
                    if log:
                        logger.info(
                            "[FastLora] stack=%s unet_keys=%d clip_entries=%d",
                            [(os.path.basename(p), sm, sc) for p, sm, sc in stack],
                            len(unet_patches), len(clip_entries),
                        )
                    if signature != state.applied:
                        try:
                            _apply_inplace(model, state, unet_patches, signature, log, backup)
                        except torch.cuda.OutOfMemoryError:
                            logger.warning("[FastLora] backup OOM, retrying with CPU backup")
                            _restore_all(model.model, state)
                            state.backup_device = None
                            torch.cuda.empty_cache()
                            _apply_inplace(model, state, unet_patches, signature, log, "cpu")
                except _Unsupported as exc:
                    if log:
                        logger.warning("[FastLora] fast path unsupported (%s), using clone+patch", exc)
                    _restore_all(model.model, state)
                    return _safe_apply(model, clip, stack, log)
                except Exception:
                    state.applied = ()
                    raise

                if not clip_entries:
                    return (model, clip)
                new_clip = clip.clone()
                for loaded, strength in clip_entries:
                    new_clip.add_patches(loaded, strength)
                return (model, new_clip)

            _restore_all(model.model, state)
            return _safe_apply(model, clip, stack, log)
