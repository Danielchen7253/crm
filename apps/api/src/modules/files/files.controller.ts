import { Body, Controller, Post } from "@nestjs/common";

@Controller("files")
export class FilesController {
  @Post("upload")
  upload(@Body() body: any) {
    return {
      id: `file-${Date.now()}`,
      url: body.url ?? "",
      fileName: body.fileName,
      mimeType: body.mimeType ?? body.contentType,
      sizeBytes: body.sizeBytes ?? 0,
      note: "Upload placeholder; connect Cloudflare R2/S3 storage for binary persistence.",
    };
  }
}
