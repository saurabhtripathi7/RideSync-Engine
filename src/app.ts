import express from "express";
import rideRoutes from "./routes/ride.routes.js";
import driverRoutes from "./routes/driver.routes.js";
import passengerRoutes from "./routes/passenger.routes.js";
import cabRoutes from "./routes/cab.routes.js";

const app = express();
app.use(express.json());

app.use("/rides", rideRoutes);
app.use("/drivers", driverRoutes);
app.use("/passengers", passengerRoutes);
app.use("/cabs", cabRoutes);

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

export default app;