import { Controller, Post, ServiceUnavailableException } from "@nestjs/common";

@Controller("files")
export class FilesController {
  @Post("upload")
  upload() {
    throw new ServiceUnavailableException(
      "File storage is not configured. Configure R2/S3 before enabling attachments.",
    );
  }
}
