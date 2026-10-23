/**
 * Google credentials for the web app without a Google key (ADR 0072). The
 * App Runner instance role's AWS credentials are exchanged at Google STS for
 * a federated token, which then impersonates the service account. Same flow
 * and settings as the worker's `federatedVideoAuth` (apps/worker/src/vertex-video.ts);
 * kept as a copy because the two images are built from separate trees.
 */
import { AwsClient, GoogleAuth, type AuthClient } from "google-auth-library";

export type AwsCredentials = () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;

export function federatedGoogleAuth(credentials: AwsCredentials, audience: string, email: string): AwsClient {
  return new AwsClient({
    audience,
    subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${email}:generateAccessToken`,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    aws_security_credentials_supplier: {
      getAwsRegion: async () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-2",
      getAwsSecurityCredentials: async () => {
        const value = await credentials();
        return { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey, token: value.sessionToken };
      },
    },
  });
}

/** Application default credentials, for local development (`GOOGLE_APPLICATION_CREDENTIALS` or gcloud login). */
export function defaultGoogleAuth(): Promise<AuthClient> {
  return new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
}
