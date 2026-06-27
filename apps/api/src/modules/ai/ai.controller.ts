import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { AiService } from "./ai.service";

@Controller("ai")
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post("conversations/:id/suggest-reply")
  async suggestForConversation(@Param("id") id: string) {
    const suggestion = await this.ai.createSuggestionForConversation(id);
    if (!suggestion) throw new BadRequestException("No customer message found for this conversation");
    return suggestion;
  }

  @Get("training-materials")
  listTrainingMaterials() {
    return this.ai.listTrainingMaterials();
  }

  @Post("training-materials")
  async saveTrainingMaterial(@Body() body: any) {
    try {
      return await this.ai.saveTrainingMaterial(body);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Unable to save training material");
    }
  }

  @Patch("training-materials/:id")
  async updateTrainingMaterial(@Param("id") id: string, @Body() body: any) {
    try {
      return await this.ai.updateTrainingMaterial(id, body);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Unable to update training material");
    }
  }

  @Delete("training-materials/:id")
  async deleteTrainingMaterial(@Param("id") id: string) {
    try {
      return await this.ai.deleteTrainingMaterial(id);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Unable to delete training material");
    }
  }
}
