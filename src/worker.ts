import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Request, Queue, MessageBatch } from "@cloudflare/workers-types";
import { Database } from "./database.types.js";

type VersionRequest =
  Database["public"]["Tables"]["version_requests"]["Insert"];
type VersionRequestMessage = Omit<VersionRequest, "plugin_id"> & {
  plugin: string;
};

interface Env {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  MISE_VERSIONS_QUEUE: Queue<VersionRequestMessage>;
}

class DB {
  constructor(private supabase: SupabaseClient<Database>) {}

  async getOrCreatePlugin(name: string) {
    const id = await this.getPluginID(name);
    if (id) return id;

    const { data, error } = await this.supabase
      .from("plugins")
      .insert({ name: name })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async getPluginID(name: string): Promise<number | null> {
    const { data, error } = await this.supabase
      .from("plugins")
      .select("id")
      .eq("name", name)
      .maybeSingle();
    if (error) throw error;

    if (data) return data.id;
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const plugin = request.url.split("/")[3];
    if (!plugin) return new Response("Not found", { status: 404 });

    const url = new URL(request.url);
    url.hostname = "mise-versions-gh.jdx.dev";
    const response = await fetch(url);
    if (response.status !== 200) return response;

    await env.MISE_VERSIONS_QUEUE.send({
      plugin,
      ip: request.headers.get("cf-connecting-ip")!,
      user_agent: request.headers.get("user-agent")!,
      country: request.cf!.country as string,
      region: request.cf!.region as string,
      city: request.cf!.city as string,
    });

    return new Response(await response.text(), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  },

  async queue(batch: MessageBatch<VersionRequestMessage>, env: Env) {
    const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_KEY);
    const db = new DB(supabase);

    for (const { body: message } of batch.messages) {
      const pluginID = await db.getOrCreatePlugin(message.plugin);
      await supabase.from("version_requests").insert({
        plugin_id: pluginID,
        ip: message.ip,
        user_agent: message.user_agent,
        country: message.country,
        region: message.region,
        city: message.city,
      });
    }
  },
};
