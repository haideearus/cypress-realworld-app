import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function createAvatarStorage() {
  if (
    !["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION"].every(
      (name) => process.env[name]
    )
  )
    return undefined;
  const bucket = process.env.AVATAR_BUCKET || "assets";
  const client = new S3Client({
    forcePathStyle: true,
    maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return {
    async upload(key: string, bytes: Buffer, contentType: string) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          CacheControl: "private, max-age=60",
        }),
        { abortSignal: AbortSignal.timeout(10000) }
      );
    },
    url(key: string) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: 60,
      });
    },
  };
}
