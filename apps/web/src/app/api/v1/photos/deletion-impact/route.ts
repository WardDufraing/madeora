import { readDeletionImpact } from "@/photos/data";
import { deletionImpactSchema } from "@/photos/schema";
import { failure, json, readStorageMutation } from "@/storage/route-helpers";

const MAX_BODY_BYTES = 8 * 1024;

/**
 * What deleting photos from their library would affect (S36), for the confirmation before "Delete
 * from library": how many the person may delete, the libraries, the albums and Homes they can see
 * that lose the photos, and only a flag for those they cannot see. Changes nothing.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readStorageMutation(request, deletionImpactSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const read = await readDeletionImpact(input.data.photoIds);
  switch (read.status) {
    case "ok":
      return json(200, { impact: read.value });
    case "invalid":
      return failure(400, "invalid");
    case "not-found":
      return failure(404, "not-found");
    default:
      return failure(500, "failed");
  }
}
