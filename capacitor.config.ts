import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "se.kth.shelfaware",
  appName: "ShelfAware",
  webDir: "capacitor-www",
  server: {
    url: "https://shelfawareapp.pages.dev",
  },
};

export default config;
