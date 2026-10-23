from .fast_lora_patch import FastLoraStackPatch

NODE_CLASS_MAPPINGS = {
    "FastLoraStackPatch": FastLoraStackPatch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FastLoraStackPatch": "Apply LoRA Stack (In-Place)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
