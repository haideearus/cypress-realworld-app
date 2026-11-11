import React, { useState } from "react";
import { Alert, Avatar, Box, Button, Typography } from "@mui/material";
import { httpClient } from "../utils/asyncUtils";

export default function AvatarUpload({
  userId,
  avatar,
  onSaved,
}: {
  userId: string;
  avatar: string;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    setMessage("");
    setError("");
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      setError("Choose a PNG, JPEG, or WebP image of 2 MB or smaller.");
      return;
    }
    setBusy(true);
    try {
      const response = await httpClient.post("/avatars", file, {
        headers: { "Content-Type": file.type },
      });
      await httpClient.patch(`/users/${userId}`, { avatar: response.data.avatar });
      setMessage("Profile picture saved.");
      onSaved();
    } catch {
      setError("Could not save your picture. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box sx={{ mb: 2 }}>
      <Avatar
        src={avatar}
        alt="Your profile picture"
        data-test="profile-picture"
        sx={{ width: 64, height: 64, mb: 1 }}
      />
      <Button component="label" variant="outlined" disabled={busy}>
        {busy ? "Uploading…" : "Upload profile picture"}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={upload}
          data-test="avatar-file"
        />
      </Button>
      <Typography variant="caption" display="block">
        PNG, JPEG, or WebP. Maximum 2 MB.
      </Typography>
      {message && (
        <Alert severity="success" data-test="avatar-saved">
          {message}
        </Alert>
      )}
      {error && (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      )}
    </Box>
  );
}
