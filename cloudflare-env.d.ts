declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    JUZI_MODELS_KEY?: string;
    AGENT_SERVICE_URL?: string;
    AGENT_SERVICE_TOKEN?: string;
  }
}
