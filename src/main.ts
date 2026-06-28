import { Plugin, WorkspaceLeaf } from "obsidian";
import { ChatView, VIEW_TYPE } from "./view";
import { DEFAULT_SETTINGS, MVASettingTab, type MVASettings } from "./settings";

export default class MarioverseAgentPlugin extends Plugin {
  settings!: MVASettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon("bot", "Open Marioverse Agent", () => this.activateView());

    this.addCommand({
      id: "open-marioverse-agent",
      name: "Open chat",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new MVASettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private convoFile(): string {
    return `${this.manifest.dir}/conversations.json`;
  }

  /** Persisted conversation history (separate from settings/data.json). */
  async loadConversations(): Promise<unknown[]> {
    try {
      const p = this.convoFile();
      if (await this.app.vault.adapter.exists(p)) {
        const raw = await this.app.vault.adapter.read(p);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      /* corrupt/missing → start fresh */
    }
    return [];
  }

  async saveConversations(data: unknown[]): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.convoFile(), JSON.stringify(data));
    } catch {
      /* non-fatal */
    }
  }
}
