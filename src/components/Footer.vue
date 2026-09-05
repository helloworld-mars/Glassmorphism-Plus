<script setup lang="ts">
import type { VersionInfo } from '@/utils/api'
import { computed, onMounted, ref } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { getSharedApi } from '@/utils/api'

const api = getSharedApi()

const buildVersion = __BUILD_VERSION__
const buildGitHash = __BUILD_GIT_HASH__
const themeMaintainer = 'VoyagerProbe'
const themeRepository = 'https://github.com/VoyagerProbe/Glassmorphism-Plus'

const serverVersion = ref<VersionInfo | null>(null)

onMounted(async () => {
  try {
    serverVersion.value = await api.getVersion()
  }
  catch {
    // 静默失败
  }
})

const formattedServerVersion = computed(() => serverVersion.value?.version ?? '')
const themeBuildDetails = computed(() => {
  const identity = `v${buildVersion} · ${themeMaintainer}`
  return buildGitHash === 'unknown' ? identity : `${identity}\n${buildGitHash}`
})
</script>

<template>
  <footer class="w-full max-w-[1280px] mx-auto p-4">
    <div class="flex w-full flex-row justify-between gap-4 text-xs text-muted-foreground">
      <div class="flex gap-1 items-center">
        Powered by
        <DataTooltip
          as="span"
          placement="top"
          :content="formattedServerVersion"
        >
          <a
            href="https://github.com/komari-monitor/komari" target="_blank" rel="noopener noreferrer"
            class="transition-opacity hover:opacity-80"
          >
            <span class="font-medium text-foreground">Komari Monitor</span>
          </a>
        </DataTooltip>
      </div>
      <div class="flex flex-col items-end text-right leading-4">
        <div class="flex gap-1 items-center">
          Theme by
          <a
            :href="themeRepository" target="_blank" rel="noopener noreferrer"
            class="font-medium text-foreground transition-opacity hover:opacity-80"
          >
            Glassmorphism Plus
          </a>
        </div>
        <div class="flex flex-wrap gap-1 items-center justify-end text-[11px] text-muted-foreground">
          <DataTooltip as="span" placement="top" :content="themeBuildDetails">
            <span>v{{ buildVersion }} · {{ themeMaintainer }}</span>
          </DataTooltip>
        </div>
      </div>
    </div>
  </footer>
</template>
