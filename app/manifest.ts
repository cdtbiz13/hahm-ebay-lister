import type { MetadataRoute } from "next";

// Lets the app be added to a phone's home screen and open full-screen.
// It opens on Intake, since the phone is mostly used for logging new finds.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Resale Lister",
    short_name: "Lister",
    description: "Log new finds into the tracker and turn photos into eBay listings.",
    start_url: "/intake",
    scope: "/",
    display: "standalone",
    background_color: "#faf6ec",
    theme_color: "#1d6b5f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
