/** Charge le .env racine du monorepo (en dev ; en prod les variables viennent du conteneur). */
import dotenv from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../../.env") });
