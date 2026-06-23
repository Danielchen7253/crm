import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { TagsService, type TagFilter } from "./tags.service";

@Controller("tags")
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  list(@Query("q") q?: string, @Query("group") group?: string, @Query("active") active?: string) {
    return this.tags.list({ q, group, active });
  }

  @Get("export")
  export(@Query("active") active?: string) {
    return this.tags.list({ active });
  }

  @Post("seed-defaults")
  seedDefaults() {
    return this.tags.seedDefaults();
  }

  @Post()
  create(@Body() body: { name: string; groupName?: string; color?: string; description?: string; isActive?: boolean }) {
    return this.tags.upsertByName(body);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: { name?: string; groupName?: string; color?: string; description?: string; isActive?: boolean },
  ) {
    return this.tags.update(id, body);
  }

  @Delete(":id")
  hide(@Param("id") id: string) {
    return this.tags.hide(id);
  }

  @Post("merge")
  merge(@Body() body: { sourceTagId: string; targetTagId: string; actorId?: string }) {
    return this.tags.merge(body.sourceTagId, body.targetTagId, body.actorId);
  }

  @Post("customers/:customerId")
  assignToCustomer(
    @Param("customerId") customerId: string,
    @Body() body: { tagIds?: string[]; tagNames?: string[]; actorId?: string },
  ) {
    return this.tags.assignToCustomer(customerId, body);
  }

  @Delete("customers/:customerId/:tagId")
  removeFromCustomer(@Param("customerId") customerId: string, @Param("tagId") tagId: string) {
    return this.tags.removeFromCustomer(customerId, tagId);
  }

  @Post("bulk-assign")
  bulkAssign(@Body() body: { customerIds: string[]; tagIds?: string[]; tagNames?: string[]; actorId?: string }) {
    return this.tags.bulkAssign(body);
  }

  @Post("filter-customers")
  filterCustomers(@Body() body: TagFilter) {
    return this.tags.filterCustomers(body);
  }

  @Post("import")
  import(@Body() body: { tags: Array<{ name: string; groupName?: string; color?: string; description?: string }> }) {
    return this.tags.importTags(body.tags);
  }
}
