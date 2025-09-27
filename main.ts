import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  Vault,
} from "obsidian";

/** ---------- Settings ---------- */

type InsertPosition = "top" | "bottom";

interface TaskMoverSettings {
  tasksRootDir: string;        // e.g., "!ToDo/"
  completedRootDir: string;    // e.g., "!ToDo/ToDo (Completed)/"
  insertPosition: InsertPosition; // "top" or "bottom"
  createMissingHeadings: boolean; // ensure destination heading exists
  includeGlob: string;         // optional file-name filter (simple "includes" match)
}

const DEFAULT_SETTINGS: TaskMoverSettings = {
  tasksRootDir: "!ToDo/",
  completedRootDir: "!ToDo/ToDo (Completed)/",
  insertPosition: "top",
  createMissingHeadings: true,
  includeGlob: ".md",
};

/** ---------- Plugin ---------- */

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureDateStamp(line: string): string {
  // If it already has a ✅ YYYY-MM-DD, leave it alone.
  if (/✅\s*\d{4}-\d{2}-\d{2}\b/.test(line)) return line;
  // Otherwise append today's date.
  const date = todayISO();
  // Keep one space before the stamp
  return `${line.trimEnd()} ✅ ${date}`;
}

export default class TaskMoverPlugin extends Plugin {
  settings: TaskMoverSettings = DEFAULT_SETTINGS;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new TaskMoverSettingTab(this.app, this));

    this.addCommand({
      id: "move-completed-tasks",
      name: "Move completed tasks to Completed files",
      callback: () =>
        this.moveCompletedTasks().catch((err) => {
          console.error(err);
          new Notice("Task Mover: Error (see console)");
        }),
    });

    new Notice("Task Mover loaded");
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private isInScope(file: TFile): boolean {
    const p = file.path;
    const ROOT_DIR = this.normDir(this.settings.tasksRootDir);
    const COMPLETED_DIR = this.normDir(this.settings.completedRootDir);

    if (!p.startsWith(ROOT_DIR)) return false;
    if (p.startsWith(COMPLETED_DIR)) return false;
    if (this.settings.includeGlob && !p.includes(this.settings.includeGlob)) return false;
    return p.endsWith(".md");
  }

  private normDir(d: string): string {
    // Ensure trailing slash for safe startsWith checks
    let out = d.trim();
    if (out && !out.endsWith("/")) out += "/";
    return out;
  }

  private completedPathFor(srcPath: string): string {
    // "!ToDo/1. ToDo (Administrative).md"
    // -> "!ToDo/ToDo (Completed)/1. ToDo (Administrative) - Completed.md"
    const ROOT_DIR = this.normDir(this.settings.tasksRootDir);
    const COMPLETED_DIR = this.normDir(this.settings.completedRootDir);

    const base = srcPath.replace(ROOT_DIR, "");
    const nameOnly = base.replace(/\.md$/i, "");
    const completedName = `${nameOnly} - Completed.md`;
    return normalizePath(COMPLETED_DIR + completedName);
  }

  private async ensureFile(vault: Vault, path: string, initial = ""): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    const folderPath = path.split("/").slice(0, -1).join("/");
    if (folderPath && !(this.app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
      await vault.createFolder(folderPath);
    }
    return await vault.create(path, initial);
  }

  private getHeading(line: string): string | null {
    // Match "## **Heading**", "## Heading", "#### Heading" etc.
    const m = line.match(/^\s{0,3}(#{2,6})\s+(.*)$/);
    if (!m) return null;
    let title = m[2].trim();
    const bold = title.match(/^\*\*(.+?)\*\*$/);
    if (bold) title = bold[1].trim();
    return title;
  }

  private isCompletedTask(line: string): boolean {
    return /^\s*[-*]\s+\[(x|X)\]\s+/.test(line);
  }

  private trimExtraBlankLines(lines: string[]): string[] {
    const out: string[] = [];
    let blankRun = 0;
    for (const l of lines) {
      if (l.trim() === "") {
        blankRun++;
        if (blankRun <= 1) out.push(l);
      } else {
        blankRun = 0;
        out.push(l);
      }
    }
    return out;
  }

  private insertByHeadings(
    destContent: string,
    byHeading: Map<string, string[]>
  ): string {
    const lines = destContent.split(/\r?\n/);
    const insertPosPrefersTop = this.settings.insertPosition === "top";

    // Helper
    const insertAt = (arr: string[], index: number, items: string[]) => {
      arr.splice(index, 0, ...items);
    };

    const firstHeadingIdx = lines.findIndex((l) => this.getHeading(l) !== null);

    for (const [heading, tasks] of byHeading.entries()) {
      if (!tasks.length) continue;

      // Normalize task block spacing
      const taskBlock = [...tasks];

      if (heading === "_ROOT_") {
        if (insertPosPrefersTop) {
          // Immediately after first heading, or at top if no headings.
          let idx = 0;
          if (firstHeadingIdx !== -1) {
            idx = firstHeadingIdx + 1;
            if (lines[idx] && lines[idx].trim() !== "") {
              insertAt(lines, idx, [""]);
              idx += 1;
            }
          }
          insertAt(lines, idx, taskBlock);
          // Add a blank line after the inserted block if needed
          const after = idx + taskBlock.length;
        } else {
          // Append at end for bottom mode
          if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
          lines.push(...taskBlock);
        }
        continue;
      }

      // Find existing heading
      let hIdx = lines.findIndex((l) => {
        const h = this.getHeading(l);
        return h && h.toLowerCase() === heading.toLowerCase();
      });

      if (hIdx === -1) {
        if (!this.settings.createMissingHeadings) {
          // If we are not allowed to create, drop into ROOT behavior
          if (insertPosPrefersTop) {
            let idx = 0;
            if (firstHeadingIdx !== -1) {
              idx = firstHeadingIdx + 1;
              if (lines[idx] && lines[idx].trim() !== "") {
                insertAt(lines, idx, [""]);
                idx += 1;
              }
            }
            insertAt(lines, idx, taskBlock);
          } else {
            if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
            lines.push(...taskBlock);
          }
          continue;
        }

        // Create heading at end, then add tasks beneath
        if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
        lines.push(`## **${heading}**`);
        if (insertPosPrefersTop) {
          // Top of newly created section = directly after heading
          lines.push(...taskBlock);
        } else {
          // For bottom mode it’s the same (no existing content)
          lines.push(...taskBlock);
        }
        continue;
      }

      // Insert into existing section
      let sectionStart = hIdx + 1;

      if (insertPosPrefersTop) {
        // Prepend: right after heading line (and optional blank)
        insertAt(lines, sectionStart, taskBlock);
        // Optional tidy blank line after inserted block
        const after = sectionStart + taskBlock.length;
      } else {
        // Append to bottom of section: find next heading or EOF
        let insertAtIdx = lines.length;
        for (let i = sectionStart; i < lines.length; i++) {
          if (this.getHeading(lines[i])) {
            insertAtIdx = i;
            break;
          }
        }
        insertAt(lines, insertAtIdx, taskBlock);
      }
    }

    return lines.join("\n");
  }

  private async moveCompletedTasks() {
    const { vault } = this.app;
    const files = this.app.vault.getMarkdownFiles().filter((f) => this.isInScope(f));
    if (!files.length) {
      new Notice("Task Mover: No source files found in tasks root");
      return;
    }

    let movedCount = 0;

    for (const file of files) {
      const src = await vault.read(file);
      const lines = src.split(/\r?\n/);

      // Collect completed tasks, grouped by heading
      let currentHeading: string | null = null;
      const keepLines: string[] = [];
      const byHeading: Map<string, string[]> = new Map(); // heading -> completed task lines

      for (const line of lines) {
        const h = this.getHeading(line);
        if (h) {
          currentHeading = h;
          keepLines.push(line);
          continue;
        }

        if (this.isCompletedTask(line)) {
          const key = currentHeading ?? "_ROOT_";
          if (!byHeading.has(key)) byHeading.set(key, []);
          // ADD DATE HERE:
          byHeading.get(key)!.push(ensureDateStamp(line));
          movedCount++;
          continue; // omit from source
        }

        keepLines.push(line);
      }

      // If nothing completed, skip writes
      if ([...byHeading.values()].every((arr) => arr.length === 0)) continue;

      // Update source
      await vault.modify(file, this.trimExtraBlankLines(keepLines).join("\n"));

      // Append/prepend into destination
      const destPath = this.completedPathFor(file.path);
      const abstractFile = this.app.vault.getAbstractFileByPath(destPath);
      let destFile: TFile | null = null;

      if (abstractFile instanceof TFile) {
        destFile = abstractFile;
      }

      if (!destFile) {
        // Create a scaffold header line mirroring the active file’s main header
        const baseName = destPath.split("/").pop()!.replace(/\.md$/i, "");
        // Strip " - Completed" for a cleaner title within the file if you like:
        const title = baseName.replace(/\s*-\s*Completed$/i, "");
        const initial = `## **${title}**\n`;
        destFile = await this.ensureFile(vault, destPath, initial);
      }

      const destContent = await vault.read(destFile);
      const updatedDest = this.insertByHeadings(destContent, byHeading);
      await vault.modify(destFile, updatedDest);
    }

    new Notice(`Task Mover: Moved ${movedCount} completed task${movedCount === 1 ? "" : "s"}.`);
  }
}

/** ---------- Settings Tab ---------- */

class TaskMoverSettingTab extends PluginSettingTab {
  plugin: TaskMoverPlugin;

  constructor(app: App, plugin: TaskMoverPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Task Mover – Settings" });

    new Setting(containerEl)
      .setName("Tasks root directory")
      .setDesc("Folder containing your active ToDo files (with trailing slash).")
      .addText((tb) =>
        tb
          .setPlaceholder("!ToDo/")
          .setValue(this.plugin.settings.tasksRootDir)
          .onChange(async (v) => {
            this.plugin.settings.tasksRootDir = this.cleanDir(v);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Completed root directory")
      .setDesc("Folder for your Completed files (with trailing slash).")
      .addText((tb) =>
        tb
          .setPlaceholder("!ToDo/ToDo (Completed)/")
          .setValue(this.plugin.settings.completedRootDir)
          .onChange(async (v) => {
            this.plugin.settings.completedRootDir = this.cleanDir(v);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Insert position")
      .setDesc("Place moved tasks at the top or bottom of each section.")
      .addDropdown((dd) =>
        dd
          .addOption("top", "Top")
          .addOption("bottom", "Bottom")
          .setValue(this.plugin.settings.insertPosition)
          .onChange(async (v) => {
            this.plugin.settings.insertPosition = v as InsertPosition;
            await this.plugin.saveSettings();
          })
      );


    new Setting(containerEl)
      .setName("Create missing headings")
      .setDesc("If a matching heading doesn't exist in the Completed file, create it.")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.createMissingHeadings)
          .onChange(async (v) => {
            this.plugin.settings.createMissingHeadings = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include filter")
      .setDesc("Only process files whose path includes this text (leave as .md to include all Markdown).")
      .addText((tb) =>
        tb
          .setPlaceholder(".md")
          .setValue(this.plugin.settings.includeGlob)
          .onChange(async (v) => {
            this.plugin.settings.includeGlob = v.trim() || ".md";
            await this.plugin.saveSettings();
          })
      );
  }

  private cleanDir(v: string): string {
    let s = v.trim();
    if (!s) return s;
    if (!s.endsWith("/")) s += "/";
    return s;
  }
}
