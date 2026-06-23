import { Module } from "@nestjs/common";
import { TagsModule } from "../tags/tags.module";
import { CustomersController } from "./customers.controller";

@Module({ imports: [TagsModule], controllers: [CustomersController] })
export class CustomersModule {}
