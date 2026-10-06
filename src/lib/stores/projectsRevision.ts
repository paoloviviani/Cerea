import { writable } from "svelte/store";

/**
 * Bumped whenever the project page changes what the sidebar's Projects tree
 * shows (a project created, renamed or deleted, a chat taken out of it). The
 * tree reloads on it; the page and the tree share no other state.
 */
export const projectsRevision = writable(0);
export const projectsChanged = () => projectsRevision.update((n) => n + 1);
