import express from "express";
import cors from "cors";
import { env } from "./env.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/validate", async (req, res) => {
  try {
    // Validation logic will go here
    res.json({ message: "Validation endpoint" });
  } catch (error) {
    console.error("Validation error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = env.PORT;

app.listen(PORT, () => {
  console.log(`Validator service running on port ${PORT}`);
});
