import { writable } from "svelte/store";

/**
 * The open project's name, for the phone's top bar. Set by the project page
 * once it has loaded the project and cleared when it goes; the layout reads it
 * because the bar lives outside the page.
 */
export const projectTitle = writable("");
