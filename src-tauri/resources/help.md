# Folio Help

Folio is a quiet, fast, read-only viewer for Markdown. It never changes your files, sends nothing anywhere, and only touches the network for images and links a document itself refers to.

> [!TIP]
> This page is a Markdown document too. Press <kbd>⌘</kbd><kbd>/</kbd> to see its source.

## Opening documents

- **Double-click** a Markdown file in Finder once Folio is your default Markdown app.
- **File ▸ Open…** (<kbd>⌘O</kbd>) opens files and folders; **Open Folder…** (<kbd>⌥⌘O</kbd>) opens a folder in the sidebar with its README.
- **Drop** files or folders anywhere in a window. Drop them on the tab bar to place the new tabs exactly where the insertion marker shows.
- **File ▸ Open Recent** lists recent documents and folders; Folio remembers where you were in each one.
- **Open Quickly** (<kbd>⇧⌘O</kbd>) finds any Markdown file in the open folder, your open tabs, and your recent documents. Type a few letters of the name; add a slash (`docs/gui`) to match folders too.

Folio reads UTF-8 (with or without a byte order mark), UTF-16 with a byte order mark, and falls back to Windows-1252 with a notice. Files over 10 MB open as source first, with an offer to render them. Files still in iCloud show “Downloading…” and appear as soon as they arrive.

### Making Folio the default Markdown app

Folio offers this once, on its first launch. You can also use **Settings ▸ General ▸ Make Default** at any time. It covers `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.mdtxt` and `.mdtext`.

## Tabs and windows

Each window holds tabs; each tab has its own view, scroll position, split ratio and back/forward history.

| Action | Shortcut |
|:--|:--|
| New tab / new window | <kbd>⌘T</kbd> / <kbd>⌘N</kbd> |
| Close tab / close window | <kbd>⌘W</kbd> / <kbd>⇧⌘W</kbd> |
| Reopen closed tab | <kbd>⇧⌘T</kbd> |
| Select tab 1–8 / last tab | <kbd>⌘1</kbd>–<kbd>⌘8</kbd> / <kbd>⌘9</kbd> |
| Next / previous tab | <kbd>⌃⇥</kbd> / <kbd>⌃⇧⇥</kbd>, or <kbd>⇧⌘]</kbd> / <kbd>⇧⌘[</kbd> |

Drag tabs to reorder them. Right-click a tab for **Close Other Tabs**, **Copy Path**, **Reveal in Finder**, **Open in Editor** and **Move to New Window**; <kbd>⌘</kbd>-click it to see the folders that contain the file. **Window ▸ Merge All Windows** gathers every tab into one window.

When two tabs show files with the same name, Folio adds the folder that tells them apart: “README.md — api”.

Folio restores your windows and tabs when you relaunch, following **Close windows when quitting an application** in System Settings ▸ Desktop & Dock. Change this in **Settings ▸ General ▸ Restore windows**.

## Preview, Code and Split

| View | Shortcut |
|:--|:--|
| Toggle Preview and Code | <kbd>⌘/</kbd> |
| Toggle Split | <kbd>⌘\</kbd> |
| Soft wrap in Code view | <kbd>⌥Z</kbd> |

**Code** shows the source with line numbers and folding by heading; it's read-only but fully navigable. **Split** shows both side by side and keeps them in step as you scroll; drag the divider to resize, double-click it to reset. **Double-click** any paragraph in Preview to jump to its line in the source.

**Open in Editor** (<kbd>⇧⌘E</kbd>) opens the file in your editor; Visual Studio Code and Cursor open it at the line you're reading. Folio detects Visual Studio Code, Cursor, Zed, Sublime Text and BBEdit, and falls back to TextEdit; choose one in **Settings ▸ Advanced**.

## Reading and navigating

- **Find** with <kbd>⌘F</kbd>, then <kbd>⌘G</kbd> / <kbd>⇧⌘G</kbd> for the next and previous match. <kbd>⌘E</kbd> uses the selection. <kbd>Esc</kbd> closes the bar.
- **Sidebar** (<kbd>⌃⌘S</kbd>): **Outline** lists the headings and follows along as you read; **Files** shows the Markdown files of the open folder.
- **Back and Forward** (<kbd>⌘[</kbd> and <kbd>⌘]</kbd>) retrace links you followed, including jumps within a document.
- **Next and previous heading**: <kbd>⌥⌘↓</kbd> and <kbd>⌥⌘↑</kbd>.
- **Text size**: <kbd>⌘+</kbd>, <kbd>⌘−</kbd>, and <kbd>⌘0</kbd> for actual size. Text reflows; nothing scrolls sideways.
- **Copy** keeps formatting when pasted into rich-text apps. **Edit ▸ Copy as Markdown** copies the source of the selected blocks; **Copy as HTML** copies clean HTML.

### Links

| Link | What happens |
|:--|:--|
| `#heading` | Scrolls within the document |
| Another Markdown file | Opens in the same tab (<kbd>⌘</kbd>-click for a new tab) |
| A text or code file | Opens in a new tab in Code view |
| Any other local file | Shown in Finder, never launched |
| `https:`, `http:`, `mailto:` | Opens in your browser or mail app |
| Anything else | Blocked |

## Live reload

Folio watches every open document. When a file changes on disk, it re-renders in place and keeps your reading position; changed paragraphs glow briefly (turn this off in **Settings ▸ Reading**, and it's always off with Reduce Motion). If a file is moved or deleted, Folio keeps showing the last version, with a banner that offers to locate it. **File ▸ Reload** (<kbd>⌘R</kbd>) re-reads the file at any time.

## What renders

CommonMark and GitHub Flavored Markdown: tables, task lists, strikethrough, autolinks and footnotes, plus:

- GitHub alerts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` and `[!CAUTION]`.
- Syntax highlighting for fenced code in over 200 languages.
- Math with `$inline$`, `$$display$$` and ```` ```math ```` fences: $e^{i\pi} + 1 = 0$.
- Mermaid diagrams in ```` ```mermaid ```` fences.
- Emoji shortcodes such as `:sparkles:` :sparkles:.
- YAML (`---`) and TOML (`+++`) front matter, hidden or shown as a card (**Settings ▸ Reading**).
- A safe subset of HTML: `<details>`, `<kbd>`, `<sub>`, `<sup>`, `<picture>`, images with a size, and centered paragraphs. Scripts, frames, forms and event handlers never run.

Headings get the same anchors as on GitHub, so links like `README.md#installation` work.

Images load from paths relative to the document; images on the web load unless you turn that off in **Settings ▸ Advanced**.

## Themes

**View ▸ Theme** switches between **Claude** (warm ivory), **GitHub** and **Paper**, each in light and dark. **View ▸ Appearance** follows the system or forces Light or Dark.

To make your own, put a `.css` file in the themes folder (**View ▸ Theme ▸ Open Themes Folder**, which is `~/Library/Application Support/Folio/themes`). It appears in the Theme menu and reloads whenever you save it. Themes style the document through CSS variables such as `--surface`, `--text`, `--link` and `--accent`, and the `.markdown-body` element.

## The `folio` command

Choose **Folio ▸ Install Command Line Tool…** to add `folio` to `/usr/local/bin` (or `~/.local/bin` if that isn't possible).

```console
$ folio README.md docs/*.md     # open files, each in a tab
$ folio .                       # open a folder and its README
$ cat notes.md | folio -        # show standard input
$ folio --split --line 120 CHANGELOG.md
$ folio --new-window guide.md
```

Options: `--code`, `--split`, `--preview`, `--line N`, `--new-window`, `--help` and `--version`. Folio also answers `folio://open?path=…` links, and opens only existing Markdown files and folders from them.

## Printing and exporting

**File ▸ Print…** (<kbd>⌘P</kbd>) prints the document without window chrome, on white paper. **File ▸ Export ▸ HTML…** saves a single self-contained HTML file, with images and fonts embedded.

## Privacy

Folio has no accounts, analytics or update checks. It reads only the files you open (and the images and linked files next to them), and connects to the internet only to load images a document refers to. Logs stay on your Mac; **Help ▸ Show Logs** opens them.

## Troubleshooting

> [!NOTE]
> If a document looks wrong, **Help ▸ Show Logs** shows what Folio saw. Logs are in `~/Library/Logs/Folio`.

- **Markdown files still open in another app.** Use **Settings ▸ General ▸ Make Default**. If another app claims `.md` files strongly, use Finder's **Get Info ▸ Open with ▸ Change All…** once.
- **`folio: command not found`.** Choose **Install Command Line Tool…** again, then open a new Terminal window. With the `~/.local/bin` fallback, add it to your `PATH`.
- **An image doesn't appear.** Local images load from paths relative to the document (or, for paths starting with `/`, relative to the open folder). Remote images need **Load images from the internet** in **Settings ▸ Advanced**.
