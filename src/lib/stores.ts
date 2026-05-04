import { writable } from "svelte/store";

export const setupState = writable({
  step: "wifi", // wifi | provision | connecting | success
  deviceId: null as string | null,
  shelfId: null as string | null,
  error: null as string | null
});