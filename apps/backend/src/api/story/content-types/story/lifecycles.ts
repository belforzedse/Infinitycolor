import { extractRelationId, prepareStoryMutation } from "../../lib/story-items";

async function validateAndNormalizeStory(event: any) {
  const data = event.params?.data;
  if (!data || typeof data !== "object") return;
  const storyId = Number(event.params?.where?.id);
  await prepareStoryMutation(
    strapi,
    data as Record<string, unknown>,
    Number.isFinite(storyId) && storyId > 0 ? storyId : undefined,
  );
}

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
  async beforeCreate(event: any) {
    await validateAndNormalizeStory(event);
  },
  async beforeUpdate(event: any) {
    await validateAndNormalizeStory(event);
  },
  async afterCreate(event: any) {
    await enqueueVideoNormalization(event);
  },
  async afterUpdate(event: any) {
    await enqueueVideoNormalization(event);
  },
};
