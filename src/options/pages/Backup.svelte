<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { exportConfig, importConfig } from "$lib/api";

  let status = $state<{ kind: "ok" | "error"; text: string }>();

  async function download() {
    const url = URL.createObjectURL(new Blob([await exportConfig()], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "cdn-mirror-settings.json" });
    a.click();
    URL.revokeObjectURL(url);
  }

  async function upload(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    try {
      await importConfig(await file.text());
      status = { kind: "ok", text: "Settings imported." };
    } catch (err) {
      status = { kind: "error", text: err instanceof Error ? err.message : String(err) };
    } finally {
      e.currentTarget.value = "";
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Backup</Card.Title>
    <Card.Description>Export your settings and site lists, or restore them from a file. A file that does not validate changes nothing.</Card.Description>
  </Card.Header>
  <Card.Content class="flex flex-col gap-3">
    <div><Button variant="secondary" onclick={download}>Export settings</Button></div>
    <label class="flex flex-col gap-1.5 text-sm">
      Import settings
      <Input type="file" accept="application/json,.json" onchange={upload} />
    </label>
    {#if status}
      <p class={status.kind === "error" ? "text-destructive text-sm" : "text-sm"} role={status.kind === "error" ? "alert" : "status"}>{status.text}</p>
    {/if}
  </Card.Content>
</Card.Root>
