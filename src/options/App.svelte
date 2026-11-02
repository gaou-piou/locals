<script lang="ts">
  import { PersistedState } from "runed";
  import * as Tabs from "$lib/components/ui/tabs";
  import { SettingsStore } from "$lib/settings-store.svelte";
  import Backup from "./pages/Backup.svelte";
  import General from "./pages/General.svelte";
  import Libraries from "./pages/Libraries.svelte";
  import Sites from "./pages/Sites.svelte";
  import Stats from "./pages/Stats.svelte";

  const store = new SettingsStore();
  const tab = new PersistedState("cdn-mirror:options-tab", "general");
</script>

<main class="mx-auto flex max-w-3xl flex-col gap-6 p-6">
  <h1 class="text-xl font-semibold">cdn-mirror</h1>
  <Tabs.Root value={tab.current} onValueChange={(v) => (tab.current = v)}>
    <Tabs.List>
      <Tabs.Trigger value="general">General</Tabs.Trigger>
      <Tabs.Trigger value="sites">Sites</Tabs.Trigger>
      <Tabs.Trigger value="stats">Stats</Tabs.Trigger>
      <Tabs.Trigger value="libraries">Libraries</Tabs.Trigger>
      <Tabs.Trigger value="backup">Backup</Tabs.Trigger>
    </Tabs.List>
    <div class="pt-4">
      <Tabs.Content value="general"><General {store} /></Tabs.Content>
      <Tabs.Content value="sites"><Sites {store} /></Tabs.Content>
      <Tabs.Content value="stats"><Stats /></Tabs.Content>
      <Tabs.Content value="libraries"><Libraries /></Tabs.Content>
      <Tabs.Content value="backup"><Backup /></Tabs.Content>
    </div>
  </Tabs.Root>
</main>
