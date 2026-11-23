// Shared types for the Contexts feature (server side).

import type { DesktopsListView } from './desktop-admin.ts';
import type { LayoutPreset } from './layouts.ts';

export type ContextStatus = 'working' | 'waiting' | 'idle' | 'parked';
export type AgentStatus = 'working' | 'waiting' | 'idle';
export type AssignSource = 'auto' | 'owner';
export type NameSetBy = 'owner' | 'switchyard';

export interface BrowserTab {
  readonly id: string | number;
  readonly url: string;
  readonly title: string;
}

export interface BrowserInfo {
  readonly windowId: string | number;
  readonly name: string | null;
  readonly tabs: readonly BrowserTab[];
  /** The active tab's title. A named Chrome window shows its name as the window title, not the page. */
  readonly activeTitle?: string | null;
}

/** One window as reported by the macOS app. */
export interface SnapshotWindow {
  readonly key: string;
  readonly app: string;
  readonly bundleId: string;
  readonly pid: number;
  readonly title: string;
  readonly document: string | null;
  readonly browser: BrowserInfo | null;
  /** Desktop number 1–16, counted across displays as Ctrl+N does; null when fullscreen, minimized or on all desktops. */
  readonly desktop?: number | null;
  /** Native tab titles in tab-bar order, for terminal windows showing a tab bar (two or more tabs). */
  readonly tabTitles?: readonly string[];
}

/** One usable desktop as the Mac app sees it. */
export interface DesktopEntry {
  readonly number: number;
  /** macOS ManagedSpaceID; the app checks it again before closing the desktop. */
  readonly space: number;
  /** 1-based display index, in the order desktops are numbered. */
  readonly screen: number;
  /** The screen is the laptop's own. */
  readonly builtin: boolean;
  /** Some display shows this desktop now. */
  readonly showing: boolean;
}

export interface DesktopsInfo {
  readonly count: number;
  readonly active: number | null;
  /** Absent from apps that predate the Desktops list. */
  readonly list?: readonly DesktopEntry[];
}

export interface Snapshot {
  readonly windows: readonly SnapshotWindow[];
  /** Absent from apps that predate real desktops; null when desktops can't be used. */
  readonly desktops?: DesktopsInfo | null;
  /** False once every carry of a sort failed: the server falls back to off-screen hiding. */
  readonly canCarry?: boolean;
}

// --- Response shapes --------------------------------------------------------

export interface WindowView {
  readonly key: string;
  readonly app: string;
  readonly bundleId: string;
  readonly title: string;
  readonly name: string | null;
  readonly tabCount: number | null;
  /** One line saying what put the window in its context ("assigned by you", "title names repo o/r"); null when unsorted. */
  readonly why: string | null;
  /** The desktop the window is on, when the app knows it. */
  readonly desktop: number | null;
  /** Switchyard moved it off-screen for the active context. */
  readonly hidden: boolean;
}

export interface AgentView {
  readonly id: string;
  readonly name: string;
  readonly status: AgentStatus;
  readonly lastAction: string | null;
  readonly costToday: number | null;
}

export interface ContextView {
  readonly id: string;
  readonly name: string;
  readonly folder: string | null;
  readonly key: number | null;
  readonly color: string;
  readonly status: ContextStatus;
  readonly agents: readonly AgentView[];
  readonly windows: readonly WindowView[];
  readonly parkedWindowCount: number;
  readonly lastActiveAt: string | null;
  /** The desktop this context lives on; null in off-screen mode. */
  readonly desktop: number | null;
  /** True when the desktop is the last one, shared with unsorted windows and other contexts. */
  readonly desktopShared: boolean;
  /** Its windows whose desktop is known and differs from the context's. 0 in off-screen mode. */
  readonly strays: number;
  /** The preset the owner picked for this context; 'auto' for the automatic layout; null follows the default. */
  readonly layoutId?: string | null;
  /** The preset Tidy uses here (own, else the default); null means auto layout. */
  readonly layout?: LayoutPreset | null;
}

export interface SuggestionView {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly fromWindowKey: string;
  readonly toContextId: string;
}

/** The last command the Mac app reported as failed; cleared by the next one that works. */
export interface CommandFailure {
  readonly action: string;
  readonly error: string;
  readonly at: string;
}

export interface ContextsView {
  readonly windowControl: boolean;
  readonly activeContextId: string | null;
  readonly lastFailure: CommandFailure | null;
  readonly contexts: readonly ContextView[];
  readonly unsorted: readonly WindowView[];
  readonly suggestions: readonly SuggestionView[];
  readonly waitingCount: number;
  readonly desktopMode: 'desktops' | 'offscreen';
  /** Set only in desktop mode. */
  readonly desktops: DesktopsInfo | null;
  /** Why windows are hidden off-screen instead of using desktops, when the app said so. */
  readonly desktopNote: string | null;
  /** Sorted windows sitting on the wrong desktop. */
  readonly toSort: number;
  /** Unsorted windows Sort will carry off project desktops to the shared one. */
  readonly unsortedToMove: number;
  /** Lay out the desktops a Sort or Move changed. */
  readonly autoTidy: boolean;
  /** Desktop mode with an app that reports its desktops: one row per desktop, and the screens. */
  readonly desktopList: DesktopsListView | null;
  /** Saved layout presets, oldest first. Set by `withLayouts`. */
  readonly layouts?: readonly LayoutPreset[];
  readonly defaultLayoutId?: string | null;
}

export class ContextsError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ContextsError';
  }
}
