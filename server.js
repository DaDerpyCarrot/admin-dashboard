const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const adminRoutes = require("./routes/admin");
const authRoutes = require("./routes/auth");

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = [
  "https://roadimentary-dashboard.onrender.com",
  "https://roadimentary.wuaze.com",
  "http://127.0.0.1:5500",
  "http://localhost:5500"
];

app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

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