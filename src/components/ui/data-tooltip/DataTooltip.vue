<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui'
import { computed, ref, useSlots } from 'vue'
import { cn } from '@/lib/utils'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<Props>(), {
  placement: 'top',
  as: 'div',
})

type DataTooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

interface Props {
  /** 提示文本，留空且无 #content 插槽时不渲染气泡 */
  content?: string
  /** 气泡相对触发元素的方位 */
  placement?: DataTooltipPlacement
  /** 气泡宽度，number 视为 px；默认由内容撑起 */
  width?: number | string
  /** 气泡高度，number 视为 px；默认由内容撑起 */
  height?: number | string
  /** 包裹元素标签，默认 div */
  as?: string
  /** 包裹元素的附加类 */
  class?: HTMLAttributes['class']
  /** 气泡的附加类 */
  contentClass?: HTMLAttributes['class']
  /** 允许点击或触摸固定/关闭气泡 */
  openOnClick?: boolean
}

const slots = useSlots()
const open = ref(false)
const pinnedByClick = ref(false)
const hasContent = computed(() => Boolean(props.content || slots.content))

const sizeStyle = computed(() => {
  const style: Record<string, string> = {}
  if (props.width != null)
    style.width = typeof props.width === 'number' ? `${props.width}px` : props.width
  if (props.height != null)
    style.height = typeof props.height === 'number' ? `${props.height}px` : props.height
  return style
})

function setOpen(value: boolean): void {
  open.value = hasContent.value && value
  if (!open.value)
    pinnedByClick.value = false
}

function handlePointerEnter(event: PointerEvent): void {
  if (event.pointerType !== 'touch')
    setOpen(true)
}

function handlePointerLeave(event: PointerEvent): void {
  if (event.pointerType !== 'touch' && !pinnedByClick.value)
    setOpen(false)
}

function handleFocusIn(): void {
  setOpen(true)
}

function handleFocusOut(event: FocusEvent): void {
  if (pinnedByClick.value)
    return
  const nextTarget = event.relatedTarget
  if (!(nextTarget instanceof Node) || !(event.currentTarget as HTMLElement).contains(nextTarget))
    setOpen(false)
}

function handleClick(): void {
  if (!props.openOnClick || !hasContent.value)
    return
  if (pinnedByClick.value) {
    setOpen(false)
    return
  }
  pinnedByClick.value = true
  open.value = true
}

function handleOpenChange(value: boolean): void {
  open.value = hasContent.value && value
  if (!open.value)
    pinnedByClick.value = false
}
</script>

<template>
  <TooltipProvider :delay-duration="0" :skip-delay-duration="0" disable-hoverable-content>
    <TooltipRoot
      :open="open"
      :delay-duration="0"
      disable-hoverable-content
      disable-closing-trigger
      @update:open="handleOpenChange"
    >
      <TooltipTrigger as-child>
        <component
          :is="as"
          v-bind="$attrs"
          data-slot="data-tooltip"
          :class="cn('inline-block', props.class)"
          @pointerenter="handlePointerEnter"
          @pointerleave="handlePointerLeave"
          @focusin="handleFocusIn"
          @focusout="handleFocusOut"
          @click.capture="handleClick"
        >
          <slot />
        </component>
      </TooltipTrigger>
      <TooltipPortal v-if="hasContent">
        <TooltipContent
          role="tooltip"
          data-slot="data-tooltip-content"
          :side="placement"
          :side-offset="8"
          :collision-padding="8"
          sticky="always"
          position-strategy="fixed"
          :class="cn(
            'pointer-events-none z-50 w-fit max-w-[calc(100vw-1rem)] rounded-md border border-border bg-popover px-3 py-2 text-xs leading-4 text-popover-foreground shadow-xl',
            props.contentClass,
          )"
          :style="sizeStyle"
        >
          <slot name="content">
            {{ content }}
          </slot>
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
