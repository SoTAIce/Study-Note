# Note Tabs and Background AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add browser-style note tabs and keep AI chat running across app-screen navigation.

**Architecture:** Put deterministic tab transitions and screen visibility in small tested helpers. App owns the open-tab list and renders a dedicated tab strip; AiChatPage remains mounted inside a persistent screen host whose visibility changes without unmounting.

**Tech Stack:** React 19, TypeScript 7, Node test runner, CSS

**Spec:** `docs/superpowers/specs/2026-11-03-note-tabs-ai-background-design.md`

## Global Constraints

- Preserve existing autosave and conflict blocking behavior.
- Add no dependencies.
- Do not push this second-stage change without a new user request.

## Review Focus

- Closing the active first, middle, or last tab selects the expected neighbor.
- A failed save prevents switching or closing the active note.
- Duplicate note opens do not create duplicate tabs.
- AI chat remains mounted while hidden and resumes with its live stream state.
- Hidden screens do not participate in layout or accessibility navigation.

---

### Task 1: Note tab state and UI

**Files:**
- Create: `web/src/lib/note-tabs.ts`
- Create: `web/src/lib/note-tabs.test.ts`
- Create: `web/src/components/NoteTabs.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles/app.css`

**Interfaces:**
- Produces: `upsertNoteTab`, `renameNoteTab`, `closeNoteTab` and `NoteTabs`.
- Consumes: existing `openNote`, `doSave`, `goHome`, and note title state.

- [ ] Write failing tests for duplicate-open, rename, and active-tab neighbor selection.
- [ ] Run the focused test and verify it fails because the helper does not exist.
- [ ] Implement the minimal tab helpers and rerun the focused test.
- [ ] Add the tab-strip component and integrate save-safe switching/closing in App.
- [ ] Run typecheck and build.

### Task 2: Persistent AI screen

**Files:**
- Create: `web/src/lib/screen-visibility.ts`
- Create: `web/src/lib/screen-visibility.test.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles/app.css`

**Interfaces:**
- Produces: `isScreenVisible(screen, target)`.
- Consumes: App's existing `Screen` state and AiChatPage.

- [ ] Write a failing visibility-policy test.
- [ ] Run the focused test and verify it fails because the helper does not exist.
- [ ] Implement the visibility helper and rerun the focused test.
- [ ] Render AiChatPage persistently and hide it without unmounting when another screen is active.
- [ ] Run the full suite, typecheck, and build.
