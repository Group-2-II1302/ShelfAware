import { writable } from "svelte/store";

export const setupState = writable({
  step: "wifi", // wifi | provision | connecting | success
  deviceId: undefined as string | undefined,
  shelfId: undefined as string | undefined,
  error: undefined as string | undefined,
  loading: false
});