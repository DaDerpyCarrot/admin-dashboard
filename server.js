const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const adminRoutes = require("./routes/admin");
const authRoutes = require("./routes/auth");

const app = express();
const PORT = process.env.PORT || 3000;

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

const allowedOrigins = new Set([
  normalizeOrigin(
    process.env.FRONTEND_ORIGIN || "https://roadimentary-website.onrender.com"
  ),
  normalizeOrigin(
    process.env.DASHBOARD_ORIGIN || "https://roadimentary-dashboard.onrender.com"
  ),
  "http://127.0.0.1:5500",
  "http://localhost:5500"
].filter(Boolean));

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.has(normalizeOrigin(origin))) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "Backend is running."
  });
});

app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);

/* ================= ERROR HANDLER ================= */

app.use((err, req, res, next) => {
  console.error("Server error:", err);

  res.status(err.status || 500).json({
    ok: false,
    message: err.message || "Internal server error.",
    details: err.details || null
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
