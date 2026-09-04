<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { computed, inject, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import VisitorInfo from '@/components/VisitorInfo.vue'
import { useVisitorAudit } from '@/composables/useVisitorAudit'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const appStore = useAppStore()
const { record: recordVisitorEvent } = useVisitorAudit()

const isScrolled = inject<ReturnType<typeof ref<boolean>>>('isScrolled', ref(false))

const siteFavicon = ref('/favicon.ico')

const themeButtons = [
  { title: '浅色模式', icon: 'icon-park-outline:sun-one', mode: 'light' },
  { title: '北京时间自动', icon: 'tabler:sun-moon', mode: 'beijing' },
  { title: '深色模式', icon: 'icon-park-outline:moon', mode: 'dark' },
] as const

const actionButtons = computed(() => {
  const buttons: Array<{ title: string, icon: string, action: string, pressed?: boolean }> = []

  if (router.currentRoute.value.name === 'home' && appStore.homeToolsEnabled) {
    buttons.push({
      title: appStore.homeAdvancedToolsVisible ? '收起首页工具' : '显示首页工具',
      icon: 'tabler:tools',
      action: 'toggleHomeTools',
      pressed: appStore.homeAdvancedToolsVisible,
    })
  }

  if (router.currentRoute.value.name === 'home' && !appStore.loading && !appStore.hidePingTaskBindingEntry) {
    buttons.push({
      title: '延迟监测中心',
      icon: 'tabler:activity-heartbeat',
      action: 'openPingCenter',
      pressed: ['pingsettings', 'node-ping-bindings'].includes(String(router.currentRoute.value.query.view ?? '')),
    })
  }

  if (!appStore.loading && (appStore.privateFeaturesAllowed || !appStore.hideAdminEntryWhenLoggedOut)) {
    buttons.push({
      title: '后台管理',
      icon: 'icon-park-outline:setting',
      action: 'jumpToSetting',
    })
  }
  return buttons
})

function handleButtonClick(action: string) {
  switch (action) {
    case 'toggleHomeTools':
      appStore.homeAdvancedToolsVisible = !appStore.homeAdvancedToolsVisible
      break
    case 'jumpToSetting':
      void recordVisitorEvent({
        event: 'admin_entry_click',
        path: router.currentRoute.value.path,
        route: String(router.currentRoute.value.name ?? ''),
      })
      location.href = '/admin'
      break
    case 'openPingCenter':
      void router.push({
        name: 'home',
        query: { ...router.currentRoute.value.query, view: 'pingsettings', pingtab: 'overview' },
      })
      break
  }
}

function selectThemeMode(mode: 'light' | 'beijing' | 'dark') {
  appStore.updateThemeMode(mode)
  void recordVisitorEvent({
    event: 'theme_mode_change',
    path: router.currentRoute.value.path,
    route: String(router.currentRoute.value.name ?? ''),
    target: mode,
  })
}

const sitename = computed(() => appStore.siteName)
</script>

<template>
  <!-- 访客 IP 组件，全局悬浮 -->
  <VisitorInfo v-if="!appStore.loading && appStore.visitorInfoEnabled" />

  <div
    class="transition-all duration-200 top-0 sticky z-10 border-b border-transparent"
    :class="isScrolled ? '!border-slate-500/10 backdrop-blur-lg' : 'bg-transparent'"
  >
    <div class="px-4 flex-between h-14 max-w-[1280px] mx-auto gap-2">
      <div class="flex min-w-0 items-center gap-2 sm:gap-3 cursor-pointer" @click="router.push('/')">
        <Avatar class="size-8 shrink-0">
          <AvatarImage :src="siteFavicon" :alt="sitename" />
          <AvatarFallback>{{ sitename.slice(0, 1) }}</AvatarFallback>
        </Avatar>
        <h3 class="m-0 min-w-0 truncate text-base font-semibold sm:text-lg">
          {{ sitename }}
        </h3>
      </div>
      <div class="ml-1 flex shrink-0 items-center gap-0.5 sm:gap-2" data-testid="header-actions">
        <div
          class="inline-flex shrink-0 items-center rounded-lg bg-background/35 p-0.5 ring-1 ring-border/40"
          role="group"
          aria-label="主题模式"
          data-testid="header-theme-group"
        >
          <Button
            v-for="button in themeButtons"
            :key="button.mode"
            variant="ghost"
            size="icon-sm"
            class="rounded-md"
            :class="appStore.selectedThemeMode === button.mode && 'bg-background/80 text-selection shadow-sm ring-1 ring-border/60'"
            :aria-label="button.title"
            :title="button.title"
            :aria-pressed="appStore.selectedThemeMode === button.mode"
            :data-testid="`theme-mode-${button.mode}`"
            @click="selectThemeMode(button.mode)"
          >
            <Icon :icon="button.icon" :width="18" :height="18" />
          </Button>
        </div>
        <Button
          v-for="button in actionButtons"
          :key="button.action"
          variant="ghost"
          size="icon-sm"
          :aria-label="button.title"
          :title="button.title"
          :data-testid="button.action === 'openPingCenter' ? 'ping-center-entry' : undefined"
          :aria-pressed="button.pressed"
          :class="button.pressed && 'bg-background/70 text-selection'"
          @click="handleButtonClick(button.action)"
        >
          <Icon :icon="button.icon" :width="18" :height="18" />
        </Button>
      </div>
    </div>
  </div>
</template>
