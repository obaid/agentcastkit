export const productPolicy = {
  version: "2026-08-30",
  principle: "The local production runtime is free. AgentCastKit charges for managed cloud services, licensed assets, and collaboration infrastructure.",
  free: [
    { feature: "capture.local", name: "Local screen and window recording", delivery: "local" },
    { feature: "automation.cua", name: "Cua Driver computer control", delivery: "local" },
    { feature: "planning.local", name: "Demo planning, rehearsal guidance, and validation", delivery: "local" },
    { feature: "jobs.local", name: "Durable local jobs and artifact storage", delivery: "local" },
    { feature: "editing.local", name: "Local editing and rendering as those capabilities ship", delivery: "local", status: "roadmap" },
  ],
  paid: [
    { feature: "tts.characters", name: "Managed text-to-speech", delivery: "cloud", status: "available" },
    { feature: "voices.premium", name: "Premium marketplace voices", delivery: "cloud", status: "available" },
    { feature: "voices.clone", name: "Personal and team voice cloning", delivery: "cloud", status: "roadmap" },
    { feature: "music.premium.downloads", name: "Premium licensed music", delivery: "cloud", status: "roadmap" },
    { feature: "brand.kits", name: "Reusable brand kits", delivery: "cloud", status: "roadmap" },
    { feature: "video.hosted.storage", name: "Hosted video delivery", delivery: "cloud", status: "roadmap" },
    { feature: "team.collaboration.seats", name: "Team collaboration", delivery: "cloud", status: "roadmap" },
  ],
  guarantees: {
    activationRequiredForLocalRecording: false,
    automaticUpload: false,
    localArtifactsRemainLocalUntilApproved: true,
    providerCredentialsExposedToAgents: false,
  },
} as const;
