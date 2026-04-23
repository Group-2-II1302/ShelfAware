import type { SupabaseClient } from "@supabase/supabase-js";
// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { createServerClient } from "@supabase/ssr";
import type { Session, User } from "@supabase/supabase-js";
import type { Database } from "$lib/database.types";

type TypedSupabaseClient = ReturnType<typeof createServerClient<Database>>;

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      supabase: SupabaseClient;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
