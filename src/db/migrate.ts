import { resolve } from "node:path";
import { openDatabase } from "./db.js";

const path = process.env.IO_DB_PATH ?? resolve("data/app.sqlite");
const db = openDatabase(path);
const rows = db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all();
db.close();
console.log(JSON.stringify({ event: "migrated", path, migrations: rows }, null, 2));
