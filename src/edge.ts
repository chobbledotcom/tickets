/**
 * Ticket Reservation System - Bunny Edge Script
 * Entry point for Bunny CDN edge deployment
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { serveHandler } from "./serve-app.ts";

BunnySDK.net.http.serve(serveHandler);
