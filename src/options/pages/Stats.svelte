<script lang="ts">
  import { PersistedState, resource } from "runed";
  import * as Card from "$lib/components/ui/card";
  import * as Table from "$lib/components/ui/table";
  import * as Tabs from "$lib/components/ui/tabs";
  import { getStats } from "$lib/api";
  import type { StatsRange } from "../../shared/messages.ts";

  const RANGES: { value: StatsRange; label: string }[] = [
    { value: "day", label: "Today" },
    { value: "week", label: "7 days" },
    { value: "month", label: "Month" },
    { value: "year", label: "Year" },
  ];

  const range = new PersistedState<StatsRange>("locals:stats-range", "week");
  const stats = resource(
    () => range.current,
    (r) => getStats(r),
  );

  // the worker flushes counts every few seconds: follow them instead of showing the numbers from when the page opened
  $effect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && "stats" in changes) void stats.refetch();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  });

  const rows = $derived(Object.entries(stats.current?.byLibrary ?? {}).sort(([, a], [, b]) => b - a));
</script>

<div class="flex flex-col gap-4">
  <Tabs.Root value={range.current} onValueChange={(v) => (range.current = v as StatsRange)}>
    <Tabs.List>
      {#each RANGES as r (r.value)}
        <Tabs.Trigger value={r.value}>{r.label}</Tabs.Trigger>
      {/each}
    </Tabs.List>
  </Tabs.Root>

  {#if stats.error}
    <p class="text-destructive text-sm" role="alert">{stats.error.message}</p>
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Description>Requests served from the extension</Card.Description>
        <Card.Title class="text-3xl tabular-nums">{stats.current?.total ?? 0}</Card.Title>
      </Card.Header>
    </Card.Root>

    {#if rows.length}
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Library</Table.Head>
            <Table.Head class="text-right">Requests</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each rows as [name, count] (name)}
            <Table.Row>
              <Table.Cell>{name}</Table.Cell>
              <Table.Cell class="text-right tabular-nums">{count}</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    {:else if !stats.loading}
      <p class="text-muted-foreground text-sm">Nothing served yet in this period. Counts need the extension loaded unpacked.</p>
    {/if}
  {/if}
</div>
