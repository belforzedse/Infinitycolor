import { extractRelationId } from "../../lib/story-items";

// No before* hooks: Items normalization belongs to the controller (prepareStoryMutation).
// entityService materializes component rows before db-layer lifecycles fire, so by then
// `data.Items` is only `{ id, __pivot }` references — re-validating them rejected every
// create, and rewriting them would drop the component join rows.

/** Queue every non-web-safe video item independently. Upload-time normalization may have
 * already completed; the worker re-checks the file and safely becomes a no-op. */
async function enqueueVideoNormalization(event: any) {
  const storyId = Number(event.result?.id ?? event.params?.where?.id);
  if (!Number.isFinite(storyId) || storyId <= 0) return;

  try {
    const story = (await strapi.entityService.findOne("api::story.story", storyId, {
      populate: { Items: { populate: { Media: true } }, Media: true },
    })) as any;
    if (!story) return;

    const items = Array.isArray(story.Items) && story.Items.length
      ? story.Items
      : [{
          Key: `legacy:${storyId}`,
          MediaType: story.MediaType,
          Media: story.Media,
        }];
    const { enqueueStoryVideoNormalization } = await import("../../../../queue/media");

    for (const item of items) {
      const fileId = extractRelationId(item?.Media);
      if (item?.MediaType !== "video" || !fileId || !item?.Media?.url) continue;
      await enqueueStoryVideoNormalization(storyId, String(item.Key), fileId);
    }
  } catch (error) {
    strapi.log.warn(
      `[story] could not queue video normalization for ${storyId}: ${(error as Error).message}`,
    );
  }
}

export default {
  async afterCreate(event: any) {
    await enqueueVideoNormalization(event);
  },
  async afterUpdate(event: any) {
    await enqueueVideoNormalization(event);
  },
};
