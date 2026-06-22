import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const permissions = [
    "inbox:read:all",
    "inbox:read:assigned",
    "inbox:send",
    "conversation:assign",
    "conversation:close",
    "customer:merge",
    "campaign:manage",
    "report:read",
    "settings:manage",
  ];

  for (const key of permissions) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: key },
    });
  }

  const roleNames = ["Admin", "Manager", "Sales", "Support"];
  for (const name of roleNames) {
    await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: "Admin" } });
  const allPermissions = await prisma.permission.findMany();
  for (const permission of allPermissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id } },
      update: {},
      create: { roleId: adminRole.id, permissionId: permission.id },
    });
  }

  const admin = await prisma.user.upsert({
    where: { email: "admin@coolfixpro.com" },
    update: { name: "CoolFix Admin" },
    create: {
      email: "admin@coolfixpro.com",
      name: "CoolFix Admin",
      passwordHash: "set-with-real-auth-before-production",
    },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: adminRole.id } },
    update: {},
    create: { userId: admin.id, roleId: adminRole.id },
  });

  const tags = [
    ["商用冰箱维修客户", "#1769e0"],
    ["家用冰箱维修客户", "#128c51"],
    ["空调维修客户", "#a26b00"],
    ["空调维修师傅", "#6f42c1"],
    ["批发商客户", "#c13b36"],
    ["推广获客", "#0f766e"],
    ["成交客户", "#1f7a3f"],
  ];

  for (const [name, color] of tags) {
    await prisma.tag.upsert({
      where: { name },
      update: { color },
      create: { name, color },
    });
  }

  const quickReplies = [
    ["Pickup Address", "Pickup address: 755 International Blvd, Houston, TX 77024."],
    ["Business Hours", "We are open Monday to Saturday. Please message us before pickup so we can confirm availability."],
    ["Capacitor Price", "Capacitor pricing depends on the uF size and quantity. Please send the size or a clear photo."],
    ["Wholesale Price", "We offer contractor and bulk pricing. Please send the quantity you need."],
    ["Zelle Payment", "We can accept Zelle. Please confirm the item and quantity first."],
    ["Shipping Available", "Orders paid before 3 PM ship same day. After 3 PM ship next business day. Holidays may delay shipping."],
    ["Warranty Policy", "Warranty depends on product type. Please send your order number and product photo."],
    ["Ask Model Number", "Please send the model number and a clear photo of the part label."],
    ["Ask Quantity", "How many pieces do you need? I can check price and availability."],
    ["Spanish Greeting", "Hola, gracias por contactar a CoolFix Pro Supply. En que podemos ayudarle?"],
  ];

  for (const [name, content] of quickReplies) {
    const language = name.includes("Spanish") ? "es" : "en";
    await prisma.quickReply.upsert({
      where: { name_language: { name, language } },
      update: { content },
      create: { name, content, language },
    });
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
