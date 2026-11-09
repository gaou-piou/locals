<script lang="ts">
  import { resource } from "runed";
  import { sum } from "ramda";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Switch } from "$lib/components/ui/switch";
  import { clearCached, getCached, setGlobal } from "$lib/api";
  import type { SettingsStore } from "$lib/settings-store.svelte";

  let { store }: { store: SettingsStore } = $props();
  const s = $derived(store.current);

  let version = $state(0);
  const cached = resource(
    () => version,
    () => getCached(),
  );
  const files = $derived(cached.current ?? []);
  const megabytes = new Intl.NumberFormat(undefined, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 });

  async function forget() {
    await clearCached();
    version++;
  }
</script>

{#if s}
  <div class="flex flex-col gap-4">
    <Card.Root>
      <Card.Header>
        <Card.Title>Serve libraries locally</Card.Title>
        <Card.Description>Replaces requests to known CDNs with the copies bundled in the extension.</Card.Description>
        <Card.Action>
          <Switch checked={s.enabled} aria-label="Serve libraries locally" onCheckedChange={(v) => setGlobal({ enabled: v })} />
        </Card.Action>
      </Card.Header>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Serve self-hosted copies by name</Card.Title>
        <Card.Description>
          Sites often host their own copy of a library, named after it and its version (for example
          <code>/js/jquery-3.7.1.min.js</code> or <code>jquery.min.js?ver=3.7.1</code>). These are served from the bundled copy right away, and
          the original is downloaded in the background and compared byte for byte: a different version is corrected and a modified file is
          handed back to the site from the next load on. The first load of a modified copy can therefore misbehave.
        </Card.Description>
        <Card.Action>
          <Switch
            checked={s.byname}
            disabled={!s.enabled}
            aria-label="Serve self-hosted copies by name"
            onCheckedChange={(v) => setGlobal({ byname: v })}
          />
        </Card.Action>
      </Card.Header>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Learn from browsing</Card.Title>
        <Card.Description>
          A versioned file from another site's CDN that you have met on three different sites is downloaded once and kept in the extension;
          from then on every site gets it locally. The more you browse, the more loads locally and the faster pages open. Only files whose
          address pins their content are kept, only on sites whose security policy allows it, and the least used ones make room for new ones.
        </Card.Description>
        <Card.Action>
          <Switch
            checked={s.autoCache}
            disabled={!s.enabled}
            aria-label="Learn from browsing"
            onCheckedChange={(v) => setGlobal({ autoCache: v })}
          />
        </Card.Action>
      </Card.Header>
      <Card.Content class="flex items-center justify-between gap-4 text-sm text-muted-foreground">
        <span data-testid="cached-count">
          {files.length === 1 ? "1 file kept" : `${files.length} files kept`} · {megabytes.format(sum(files.map((f) => f.bytes)) / 1_000_000)}
        </span>
        <Button variant="outline" size="sm" disabled={!files.length} onclick={forget}>Forget</Button>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Substitute close versions</Card.Title>
        <Card.Description>
          When a page asks for an older version that is not bundled, serve the newest bundled release of the same major version (never an older one than requested). The extension
          cannot see page hashes: a page that pins its script with an SRI hash will be blocked by the browser when a different version
          is served. Because this can break sites, it is off by default.
        </Card.Description>
        <Card.Action>
          <Switch
            checked={s.substitute}
            disabled={!s.enabled}
            aria-label="Substitute close versions"
            onCheckedChange={(v) => setGlobal({ substitute: v })}
          />
        </Card.Action>
      </Card.Header>
    </Card.Root>
  </div>
{/if}
