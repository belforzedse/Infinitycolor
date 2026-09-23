import { collectVideoUploads } from "../../../../services/media/normalize-upload-video";

/**
 * Posts had no lifecycle, so their videos got exactly one processing attempt — the
 * upload-time job — and a failure or a file attached from the media library was never
 * revisited. Queue every video on the saved post; the pipeline skips finished files.
 *
 * after* hooks only, re-reading the entity: in db lifecycles `params.data` holds
 * relation/component references rather than the saved values.
 */
async function enqueuePostVideos(event: any) {
  const postId = Number(event.result?.id ?? event.params?.where?.id);
  if (!Number.isInteger(postId) || postId <= 0) return;

  try {
    const post = (await strapi.entityService.findOne("api::post.post", postId, {
      fields: ["id"],
      populate: { Media: true, CoverImage: true },
    })) as any;
    if (!post) return;
    const videos = collectVideoUploads(post);
    if (videos.length === 0) return;

    const { enqueueVideoProcessingFor } = await import("../../../../queue/media");
    for (const file of videos) {
      await enqueueVideoProcessingFor(file.id, `post-${postId}`);
    }
  } catch (error) {
    strapi.log.warn(
      `[post] could not queue video processing for ${postId}: ${(error as Error).message}`,
    );
  }
}

export default {
  async afterCreate(event: any) {
    await enqueuePostVideos(event);
  },
  async afterUpdate(event: any) {
    await enqueuePostVideos(event);
  },
};
