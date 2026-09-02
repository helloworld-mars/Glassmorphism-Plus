<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'
import { cn } from '@/lib/utils'

interface Props {
  modelValue?: boolean
  disabled?: boolean
  id?: string
  name?: string
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
})
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<template>
  <SwitchRoot
    :id="id"
    :name="name"
    :model-value="modelValue"
    :disabled="disabled"
    type="button"
    data-slot="switch"
    :class="cn('peer inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-border/70 bg-muted/75 shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-selection/60 data-[state=checked]:bg-selection', props.class)"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <SwitchThumb
      data-slot="switch-thumb"
      class="pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5"
    />
  </SwitchRoot>
</template>
