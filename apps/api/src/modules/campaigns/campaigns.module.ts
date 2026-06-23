import { Module } from "@nestjs/common";
import { TagsModule } from "../tags/tags.module";
import { CampaignsController } from "./campaigns.controller";

@Module({ imports: [TagsModule], controllers: [CampaignsController] })
export class CampaignsModule {}
