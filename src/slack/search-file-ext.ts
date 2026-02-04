export function inferExt(file: {
  mimetype?: string;
  filetype?: string;
  name?: string;
  title?: string;
}): string | null {
  const mt = (file.mimetype || "").toLowerCase();
  const ft = (file.filetype || "").toLowerCase();

  if (mt === "image/png" || ft === "png") {
    return "png";
  }
  if (mt === "image/jpeg" || mt === "image/jpg" || ft === "jpg" || ft === "jpeg") {
    return "jpg";
  }
  if (mt === "image/webp" || ft === "webp") {
    return "webp";
  }
  if (mt === "image/gif" || ft === "gif") {
    return "gif";
  }

  if (mt === "text/plain" || ft === "text") {
    return "txt";
  }
  if (mt === "text/markdown" || ft === "markdown" || ft === "md") {
    return "md";
  }
  if (mt === "application/json" || ft === "json") {
    return "json";
  }

  const name = file.name || file.title || "";
  const m = name.match(/\\.([A-Za-z0-9]{1,10})$/);
  return m ? m[1]!.toLowerCase() : null;
}
