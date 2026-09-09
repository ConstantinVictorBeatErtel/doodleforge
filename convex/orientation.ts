// "Which way round should this object go?" — asked of a vision model through OpenRouter.
//
// The geometric answer lives in src/lib/sketchOrientation.ts: it chamfer-matches the user's ink
// against silhouettes of the mesh at a sweep of yaws. That works only when the mesh's outline
// resembles the drawing, and often it does not — Tripo builds from Klein's *reinterpretation*
// of the sketch, so the two shapes genuinely differ and pixel matching turns to noise.
//
// A vision model is asked something easier and more robust: of these numbered views, which one
// faces the way the sketch does? That is semantic rather than pixel-wise, so it survives the
// mesh not being a faithful likeness. The client renders the views (the GPU is over there) and
// this action does the asking (the key lives over here).
//
// Raw fetch rather than a provider SDK: OpenRouter is OpenAI-compatible over plain HTTP, which
// is how worlds.ts, assets.ts and tripo.ts already talk to every other provider, and it keeps
// this action in Convex's default runtime with no "use node" and no dependency to install.
import { v } from "convex/values";
import { action } from "./_generated/server";
import { orientationPrompt, orientationSchema, parseOrientation, type OrientationChoice } from "./orientationResult";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// Picking a numbered view is perceptual discrimination, not deep reasoning, so the cheap fast
// model is the right default — about half a cent per sketch. Swap it without a deploy:
// `npx convex env set OPENROUTER_VISION_MODEL anthropic/claude-opus-5`.
const DEFAULT_MODEL = "google/gemini-3.8-flash";
const TIMEOUT_MS = 60_000;

const redact = (message: string) => {
  const secret = process.env.OPENROUTER_API_KEY?.trim();
  return secret ? message.split(secret).join("[redacted]") : message;
};

/**
 * Returns the chosen view, or null when there is no answer worth acting on. Every failure —
 * missing key, dead endpoint, unparseable reply, out-of-range index — is a null rather than a
 * throw, because the caller's fallback (the geometric sweep) is a perfectly good outcome and
 * losing an object the user just paid to generate is not.
 */
export const orientSketch = action({
  args: {
    viewsStorageId: v.id("_storage"),
    sketchStorageId: v.id("_storage"),
    description: v.string(),
    views: v.number(),
  },
  handler: async (ctx, { viewsStorageId, sketchStorageId, description, views }): Promise<OrientationChoice | null> => {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    if (!key) throw new Error("OPENROUTER_API_KEY is not set on this deployment. Run `npx convex env set OPENROUTER_API_KEY <key>`.");
    if (!Number.isInteger(views) || views < 2 || views > 64) throw new Error(`views must be an integer between 2 and 64, got ${views}.`);

    // Convex storage URLs are public, which is why the sketch pipeline can hand them to fal.
    // OpenRouter fetches images the same way and recommends URLs over base64, so nothing here
    // has to encode a megabyte of PNG into the request body.
    const [viewsUrl, sketchUrl] = await Promise.all([ctx.storage.getUrl(viewsStorageId), ctx.storage.getUrl(sketchStorageId)]);
    if (!viewsUrl || !sketchUrl) return null;   // storage expired under us; the sweep still has an answer

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          // OpenRouter attribution headers — optional, and how a request is identified on the
          // dashboard when you are working out what spent the credits.
          "HTTP-Referer": "https://github.com/ConstantinVictorBeatErtel/doodleforge",
          "X-Title": "doodleforge",
        },
        body: JSON.stringify({
          model: process.env.OPENROUTER_VISION_MODEL?.trim() || DEFAULT_MODEL,
          max_tokens: 500,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: orientationPrompt(description, views) },
              { type: "image_url", image_url: { url: sketchUrl } },
              { type: "image_url", image_url: { url: viewsUrl } },
            ],
          }],
          response_format: { type: "json_schema", json_schema: orientationSchema(views) },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(redact(`Orientation call failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`));
        return null;
      }
      const body = await response.json();
      return parseOrientation(body?.choices?.[0]?.message?.content, views);
    } catch (e: any) {
      // Logged, not thrown: a timeout or a bad gateway should cost the sketch its orientation
      // guess, not its placement.
      console.warn(redact(`Orientation call failed: ${String(e?.message ?? e)}`));
      return null;
    }
  },
});
