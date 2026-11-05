import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Cuenta de servicio inventada, con una clave RSA de usar y tirar.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          ADMIN_TOKEN: "test-admin-token",
          FCM_SERVICE_ACCOUNT: JSON.stringify({
            project_id: "demo-project",
            client_email: "demo@demo-project.iam.gserviceaccount.com",
            private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          }),
          TEST_PUBLIC_JWK: JSON.stringify(publicKey.export({ format: "jwk" })),
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
