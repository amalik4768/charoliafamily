# charoliafamily
Family Tree
#!/usr/bin/env bash
set -e

APP="family-tree-app"

echo "Creating Next.js app..."

npx create-next-app@latest "$APP" \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --no-src-dir \
  --import-alias "@/*" \
  --use-npm

cd "$APP"

echo "Installing dependencies..."

npm install prisma @prisma/client next-auth bcryptjs zod
npm install -D @types/bcryptjs

echo "Initializing Prisma..."

npx prisma init

npm pkg set scripts.db:push="prisma db push"
npm pkg set scripts.db:studio="prisma studio"
npm pkg set scripts.prisma:generate="prisma generate"

cat > .env.example <<'EOF'
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"
NEXTAUTH_SECRET="replace-with-a-random-secret"
NEXTAUTH_URL="http://localhost:3000"
EOF

cat > prisma/schema.prisma <<'EOF'
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id           String   @id @default(cuid())
  name         String?
  email        String   @unique
  passwordHash String?
  image        String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  ownedTrees      FamilyTree[] @relation("TreeOwner")
  memberships     TreeMember[]
  sentInvitations Invitation[] @relation("InvitationSender")
}

model FamilyTree {
  id          String      @id @default(cuid())
  name        String
  description String?
  ownerId     String
  privacy     TreePrivacy @default(PRIVATE)
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  owner         User           @relation("TreeOwner", fields: [ownerId], references: [id])
  people        Person[]
  relationships Relationship[]
  members       TreeMember[]
  invitations   Invitation[]
}

model TreeMember {
  id        String   @id @default(cuid())
  treeId    String
  userId    String
  role      TreeRole @default(VIEWER)
  createdAt DateTime @default(now())

  tree FamilyTree @relation(fields: [treeId], references: [id], onDelete: Cascade)
  user User       @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([treeId, userId])
}

model Person {
  id         String   @id @default(cuid())
  treeId     String
  firstName  String?
  middleName String?
  lastName   String?
  maidenName String?
  gender     Gender   @default(UNKNOWN)

  birthDate  DateTime?
  birthPlace String?
  deathDate  DateTime?
  deathPlace String?
  isLiving   Boolean  @default(true)

  photoUrl  String?
  biography String?
  notes     String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tree FamilyTree @relation(fields: [treeId], references: [id], onDelete: Cascade)

  relationshipsFrom Relationship[] @relation("RelationshipFrom")
  relationshipsTo   Relationship[] @relation("RelationshipTo")

  @@index([treeId])
}

model Relationship {
  id             String           @id @default(cuid())
  treeId         String
  fromPersonId   String
  toPersonId     String
  type           RelationshipType

  parentType     ParentType?
  marriageDate   DateTime?
  marriagePlace  String?
  separationDate DateTime?
  notes          String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tree       FamilyTree @relation(fields: [treeId], references: [id], onDelete: Cascade)
  fromPerson Person     @relation("RelationshipFrom", fields: [fromPersonId], references: [id], onDelete: Cascade)
  toPerson   Person     @relation("RelationshipTo", fields: [toPersonId], references: [id], onDelete: Cascade)

  @@index([treeId])
  @@index([fromPersonId])
  @@index([toPersonId])
}

model Invitation {
  id          String    @id @default(cuid())
  treeId      String
  email       String
  role        TreeRole  @default(VIEWER)
  token       String    @unique
  acceptedAt  DateTime?
  expiresAt   DateTime
  createdAt   DateTime  @default(now())

  tree        FamilyTree @relation(fields: [treeId], references: [id], onDelete: Cascade)
  invitedById String
  invitedBy   User       @relation("InvitationSender", fields: [invitedById], references: [id])

  @@index([email])
}

enum TreePrivacy {
  PRIVATE
  SHARED
}

enum TreeRole {
  OWNER
  EDITOR
  VIEWER
}

enum Gender {
  MALE
  FEMALE
  OTHER
  UNKNOWN
}

enum RelationshipType {
  PARENT_CHILD
  SPOUSE
  PARTNER
}

enum ParentType {
  BIOLOGICAL
  ADOPTIVE
  STEP
  UNKNOWN
}
EOF

mkdir -p lib
mkdir -p types
mkdir -p components
mkdir -p "app/api/auth/[...nextauth]"
mkdir -p app/api/signup
mkdir -p app/api/trees
mkdir -p "app/api/trees/[treeId]"
mkdir -p "app/api/trees/[treeId]/people"
mkdir -p "app/api/trees/[treeId]/people/[personId]"
mkdir -p "app/api/trees/[treeId]/relationships"
mkdir -p "app/api/trees/[treeId]/relationships/[relationshipId]"
mkdir -p app/login
mkdir -p app/signup
mkdir -p app/dashboard
mkdir -p "app/trees/[treeId]"

cat > lib/prisma.ts <<'EOF'
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
EOF

cat > lib/auth.ts <<'EOF'
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Email and Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);

        if (!parsed.success) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: {
            email: parsed.data.email.toLowerCase(),
          },
        });

        if (!user || !user.passwordHash) {
          return null;
        }

        const isValid = await bcrypt.compare(
          parsed.data.password,
          user.passwordHash
        );

        if (!isValid) {
          return null;
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId as string;
      }

      return session;
    },
  },
};
EOF

cat > types/next-auth.d.ts <<'EOF'
import NextAuth from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
  }
}
EOF

cat > lib/permissions.ts <<'EOF'
import { TreeRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const rolePower: Record<TreeRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

export async function getTreeRole(userId: string, treeId: string) {
  const tree = await prisma.familyTree.findUnique({
    where: { id: treeId },
    select: { ownerId: true },
  });

  if (!tree) {
    return null;
  }

  if (tree.ownerId === userId) {
    return TreeRole.OWNER;
  }

  const member = await prisma.treeMember.findUnique({
    where: {
      treeId_userId: {
        treeId,
        userId,
      },
    },
  });

  return member?.role ?? null;
}

export async function hasTreeRole(
  userId: string,
  treeId: string,
  requiredRole: TreeRole
) {
  const role = await getTreeRole(userId, treeId);

  if (!role) {
    return false;
  }

  return rolePower[role] >= rolePower[requiredRole];
}
EOF

cat > "app/api/auth/[...nextauth]/route.ts" <<'EOF'
import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
EOF

cat > app/api/signup/route.ts <<'EOF'
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const signupSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(6),
});

export async function POST(req: Request) {
  const json = await req.json();
  const parsed = signupSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid signup data" }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();

  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  const user = await prisma.user.create({
    data: {
      name: parsed.data.name,
      email,
      passwordHash,
    },
    select: {
      id: true,
      name: true,
      email: true,
    },
  });

  return NextResponse.json({ user }, { status: 201 });
}
EOF

cat > app/api/trees/route.ts <<'EOF'
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const createTreeSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const trees = await prisma.familyTree.findMany({
    where: {
      OR: [
        { ownerId: session.user.id },
        {
          members: {
            some: {
              userId: session.user.id,
            },
          },
        },
      ],
    },
    include: {
      _count: {
        select: {
          people: true,
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  return NextResponse.json({ trees });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await req.json();
  const parsed = createTreeSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid tree data" }, { status: 400 });
  }

  const tree = await prisma.familyTree.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      ownerId: session.user.id,
      members: {
        create: {
          userId: session.user.id,
          role: "OWNER",
        },
      },
    },
  });

  return NextResponse.json({ tree }, { status: 201 });
}
EOF

cat > "app/api/trees/[treeId]/route.ts" <<'EOF'
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { TreeRole } from "@prisma/client";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasTreeRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

const updateTreeSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  privacy: z.enum(["PRIVATE", "SHARED"]).optional(),
});

type Ctx = {
  params: Promise<{ treeId: string }>;
};

export async function GET(_req: Request, ctx: Ctx) {
  const { treeId } = await ctx.params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const canView = await hasTreeRole(session.user.id, treeId, TreeRole.VIEWER);

  if (!canView) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tree = await prisma.familyTree.findUnique({
    where: { id: treeId },
    include: {
      people: true,
      relationships: true,
    },
  });

  return NextResponse.json({ tree });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { treeId } = await ctx.params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const canEdit = await hasTreeRole(session.user.id, treeId, TreeRole.OWNER);

  if (!canEdit) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const json = await req.json();
  const parsed = updateTreeSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid tree data" }, { status: 400 });
  }

  const tree = await prisma.familyTree.update({
    where: { id: treeId },
    data: parsed.data,
  });

  return NextResponse.json({ tree });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { treeId } = await ctx.params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const canDelete = await hasTreeRole(session.user.id, treeId, TreeRole.OWNER);

  if (!canDelete) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.familyTree.delete({
    where: { id: treeId },
  });

  return NextResponse.json({ success: true });
}
EOF

cat > "app/api/trees/[treeId]/people/route.ts" <<'EOF'
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { TreeRole } from "@prisma/client";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasTreeRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

const personSchema = z.object({
  firstName: z.string().max(100).optional(),
  middleName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  maidenName: z.string().max(100).optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"]).optional(),
  birthDate: z.string().optional().nullable(),
  birthPlace: z.string().max(200).optional().nullable(),
  deathDate: z.string().optional().nullable(),
  deathPlace: z.string().max(200).optional().nullable(),
  isLiving: z.boolean().optional(),
  biography: z.string().max(5000).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
});

type Ctx = {
  params: Promise<{ treeId: string }>;
};

export async function GET(_req: Request, ctx: Ctx) {
  const { treeId } = await ctx.params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const canView = await hasTreeRole(session.user.id, treeId, TreeRole.VIEWER);

  if (!canView) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const people = await prisma.person.findMany({
    where: { treeId },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return NextResponse.json({ people });
}

export async function POST(req: Request, ctx: Ctx) {
  const { treeId } = await ctx.params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const canEdit = await hasTreeRole(session.user.id, treeId, TreeRole.EDITOR);

  if (!canEdit) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const json = await req.json();
  const parsed = personSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid person data" }, { status: 400 });
  }

  const data = parsed.data;

  const person = await prisma.person.create({
    data: {
      treeId,
      firstName: data.firstName,
      middleName: data.middleName,
      lastName: data.lastName,
      maidenName: data.maidenName,
      gender: data.gender ?? "UNKNOWN",
      birthDate: data.birthDate ? new Date(data.birthDate) : null,
      birthPlace: data.birthPlace,
      deathDate: data.deathDate ? new Date(data.deathDate) : null,
      deathPlace: data.deathPlace,
      isLiving: data.isLiving ?? true,
      biography: data.biography,
      notes: data.notes,
    },
  });

  return NextResponse.json({ person }, { status: 201 });
}
EOF

cat > "app/api/trees/[treeId]/people/[personId]/route.ts" <<'EOF'
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { TreeRole } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { hasTreeRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

type Ctx = {
  params: Promise<{ treeId: string; personId: string }>;
};

export async function DELETE(_req: Request, ctx: Ctx) {
  const { treeId, personId } = await ctx.params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const canEdit = await hasTreeRole(session.user.id, treeId, TreeRole.EDITOR);

  if (!canEdit) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.person.delete({
    where: {
      id: personId,
      treeId,
    },
  });

  return NextResponse.json({ success: true });
}
EOF

cat > "app/api/trees/[treeId]/relationships/route.ts" <<'EOF'
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { TreeRole } from "@prisma/client";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasTreeRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

const relationshipSchema = z.object({
  fromPersonId: z.string().min(1),
  toPersonId: z.string().min(1),
  type: z.enum(["PARENT_CHILD", "SPOUSE", "PARTNER"]),
  parentType: z.enum(["BIOLOGICAL", "ADOPTIVE", "STEP", "UNKNOWN"]).optional(),
});

type Ctx = {
  params: Promise<{ treeId: string }>;
};

export async function GET(_req: Request, ctx: Ctx) {
  const { treeId } = await ctx.params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const canView = await hasTreeRole(session.user.id, treeId, TreeRole.VIEWER);

  if (!canView) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const relationships = await prisma.relationship.findMany({
    where: { treeId },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ relationships });
}

export async function POST(req: Request, ctx: Ctx) {
  const { treeId } = await ctx.params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const canEdit = await hasTreeRole(session.user.id, treeId, TreeRole.EDITOR);

  if (!canEdit) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const json = await req.json();
  const parsed = relationshipSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid relationship data" }, { status: 400 });
  }

  const data = parsed.data;

  if (data.fromPersonId === data.toPersonId) {
    return NextResponse.json({ error: "A person cannot be related to themselves" }, { status: 400 });
  }

  const count = await prisma.person.count({
    where: {
      treeId,
      id: {
        in: [data.fromPersonId, data.toPersonId],
      },
    },
  });

  if (count !== 2) {
    return NextResponse.json({ error: "Both people must belong to this tree" }, { status: 400 });
  }

  const relationship = await prisma.relationship.create({
    data: {
      treeId,
      fromPersonId: data.fromPersonId,
      toPersonId: data.toPersonId,
      type: data.type,
      parentType: data.type === "PARENT_CHILD" ? data.parentType ?? "UNKNOWN" : null,
    },
  });

  return NextResponse.json({ relationship }, { status: 201 });
}
EOF

cat > "app/api/trees/[treeId]/relationships/[relationshipId]/route.ts" <<'EOF'
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { TreeRole } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { hasTreeRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

type Ctx = {
  params: Promise<{ treeId: string; relationshipId: string }>;
};

export async function DELETE(_req: Request, ctx: Ctx) {
  const { treeId, relationshipId } = await ctx.params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const canEdit = await hasTreeRole(session.user.id, treeId, TreeRole.EDITOR);

  if (!canEdit) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.relationship.delete({
    where: {
      id: relationshipId,
      treeId,
    },
  });

  return NextResponse.json({ success: true });
}
EOF

cat > app/layout.tsx <<'EOF'
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Family Tree App",
  description: "Create and manage private family trees.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
EOF

cat > app/page.tsx <<'EOF'
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <section className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 text-center">
        <p className="mb-4 rounded-full bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">
          Private family tree builder
        </p>

        <h1 className="max-w-3xl text-5xl font-bold tracking-tight md:text-7xl">
          Build and manage your family story.
        </h1>

        <p className="mt-6 max-w-2xl text-lg text-slate-300">
          Create family trees, add relatives, connect relationships, and invite family members to collaborate.
          No DNA testing. No historical record searches.
        </p>

        <div className="mt-10 flex gap-4">
          <Link
            href="/signup"
            className="rounded-xl bg-emerald-400 px-6 py-3 font-semibold text-slate-950 hover:bg-emerald-300"
          >
            Get Started
          </Link>
          <Link
            href="/login"
            className="rounded-xl border border-white/20 px-6 py-3 font-semibold hover:bg-white/10"
          >
            Login
          </Link>
        </div>
      </section>
    </main>
  );
}
EOF

cat > app/signup/page.tsx <<'EOF'
"use client";

import { FormEvent, useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const form = new FormData(event.currentTarget);

    const name = String(form.get("name"));
    const email = String(form.get("email"));
    const password = String(form.get("password"));

    const res = await fetch("/api/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, email, password }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Signup failed");
      return;
    }

    const login = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (login?.error) {
      router.push("/login");
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-6">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-2xl bg-white p-8 shadow">
        <h1 className="text-2xl font-bold">Create account</h1>

        {error && <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

        <label className="mt-6 block text-sm font-medium">Name</label>
        <input name="name" required className="mt-1 w-full rounded-lg border p-3" />

        <label className="mt-4 block text-sm font-medium">Email</label>
        <input name="email" type="email" required className="mt-1 w-full rounded-lg border p-3" />

        <label className="mt-4 block text-sm font-medium">Password</label>
        <input name="password" type="password" required minLength={6} className="mt-1 w-full rounded-lg border p-3" />

        <button className="mt-6 w-full rounded-lg bg-slate-950 p-3 font-semibold text-white">
          Sign up
        </button>

        <p className="mt-4 text-sm text-slate-600">
          Already have an account? <Link href="/login" className="font-semibold underline">Login</Link>
        </p>
      </form>
    </main>
  );
}
EOF

cat > app/login/page.tsx <<'EOF'
"use client";

import { FormEvent, useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const form = new FormData(event.currentTarget);

    const res = await signIn("credentials", {
      email: String(form.get("email")),
      password: String(form.get("password")),
      redirect: false,
    });

    if (res?.error) {
      setError("Invalid email or password");
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-6">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-2xl bg-white p-8 shadow">
        <h1 className="text-2xl font-bold">Login</h1>

        {error && <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

        <label className="mt-6 block text-sm font-medium">Email</label>
        <input name="email" type="email" required className="mt-1 w-full rounded-lg border p-3" />

        <label className="mt-4 block text-sm font-medium">Password</label>
        <input name="password" type="password" required className="mt-1 w-full rounded-lg border p-3" />

        <button className="mt-6 w-full rounded-lg bg-slate-950 p-3 font-semibold text-white">
          Login
        </button>

        <p className="mt-4 text-sm text-slate-600">
          Need an account? <Link href="/signup" className="font-semibold underline">Sign up</Link>
        </p>
      </form>
    </main>
  );
}
EOF

cat > components/CreateTreeForm.tsx <<'EOF'
"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function CreateTreeForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);

    const form = new FormData(event.currentTarget);

    const res = await fetch("/api/trees", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: String(form.get("name")),
        description: String(form.get("description") || ""),
      }),
    });

    setLoading(false);

    if (res.ok) {
      event.currentTarget.reset();
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} className="rounded-2xl border bg-white p-5">
      <h2 className="font-semibold">Create new tree</h2>

      <input
        name="name"
        required
        placeholder="Family tree name"
        className="mt-4 w-full rounded-lg border p-3"
      />

      <textarea
        name="description"
        placeholder="Description, optional"
        className="mt-3 w-full rounded-lg border p-3"
      />

      <button
        disabled={loading}
        className="mt-4 rounded-lg bg-emerald-500 px-5 py-3 font-semibold text-white disabled:opacity-50"
      >
        {loading ? "Creating..." : "Create Tree"}
      </button>
    </form>
  );
}
EOF

cat > app/dashboard/page.tsx <<'EOF'
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CreateTreeForm } from "@/components/CreateTreeForm";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    redirect("/login");
  }

  const trees = await prisma.familyTree.findMany({
    where: {
      OR: [
        { ownerId: session.user.id },
        {
          members: {
            some: {
              userId: session.user.id,
            },
          },
        },
      ],
    },
    include: {
      _count: {
        select: {
          people: true,
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  return (
    <main className="min-h-screen bg-slate-100 px-6 py-10">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Your family trees</h1>
            <p className="text-slate-600">Welcome, {session.user.name ?? session.user.email}</p>
          </div>

          <Link href="/" className="text-sm font-semibold underline">
            Home
          </Link>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-[1fr_2fr]">
          <CreateTreeForm />

          <div className="grid gap-4">
            {trees.length === 0 && (
              <div className="rounded-2xl border bg-white p-8 text-center text-slate-600">
                No family trees yet. Create your first one.
              </div>
            )}

            {trees.map((tree) => (
              <Link
                key={tree.id}
                href={`/trees/${tree.id}`}
                className="rounded-2xl border bg-white p-5 shadow-sm hover:border-emerald-400"
              >
                <h2 className="text-xl font-semibold">{tree.name}</h2>
                <p className="mt-1 text-sm text-slate-600">{tree.description}</p>
                <p className="mt-4 text-sm text-slate-500">{tree._count.people} people</p>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
EOF

cat > components/TreeManager.tsx <<'EOF'
"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Person = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  gender: string;
  birthDate?: string | null;
  deathDate?: string | null;
  isLiving: boolean;
};

type Relationship = {
  id: string;
  fromPersonId: string;
  toPersonId: string;
  type: string;
};

function fullName(person: Person) {
  return [person.firstName, person.lastName].filter(Boolean).join(" ") || "Unnamed Person";
}

export function TreeManager({ treeId, treeName }: { treeId: string; treeName: string }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);

    const [peopleRes, relationshipsRes] = await Promise.all([
      fetch(`/api/trees/${treeId}/people`),
      fetch(`/api/trees/${treeId}/relationships`),
    ]);

    const peopleJson = await peopleRes.json();
    const relationshipsJson = await relationshipsRes.json();

    setPeople(peopleJson.people ?? []);
    setRelationships(relationshipsJson.relationships ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const personMap = useMemo(() => {
    return new Map(people.map((person) => [person.id, person]));
  }, [people]);

  async function addPerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);

    const res = await fetch(`/api/trees/${treeId}/people`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        firstName: String(form.get("firstName") || ""),
        lastName: String(form.get("lastName") || ""),
        gender: String(form.get("gender") || "UNKNOWN"),
        birthDate: String(form.get("birthDate") || "") || null,
        isLiving: form.get("isLiving") === "on",
      }),
    });

    if (res.ok) {
      event.currentTarget.reset();
      await load();
    }
  }

  async function addRelationship(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);

    const res = await fetch(`/api/trees/${treeId}/relationships`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fromPersonId: String(form.get("fromPersonId")),
        toPersonId: String(form.get("toPersonId")),
        type: String(form.get("type")),
        parentType: "BIOLOGICAL",
      }),
    });

    if (res.ok) {
      event.currentTarget.reset();
      await load();
    }
  }

  async function deletePerson(personId: string) {
    if (!confirm("Delete this person? Relationships connected to this person will also be removed.")) {
      return;
    }

    const res = await fetch(`/api/trees/${treeId}/people/${personId}`, {
      method: "DELETE",
    });

    if (res.ok) {
      await load();
    }
  }

  async function deleteRelationship(relationshipId: string) {
    const res = await fetch(`/api/trees/${treeId}/relationships/${relationshipId}`, {
      method: "DELETE",
    });

    if (res.ok) {
      await load();
    }
  }

  return (
    <div>
      <h1 className="text-3xl font-bold">{treeName}</h1>
      <p className="text-slate-600">Manage people and relationships in this family tree.</p>

      {loading ? (
        <p className="mt-8">Loading...</p>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-[360px_1fr]">
          <div className="space-y-6">
            <form onSubmit={addPerson} className="rounded-2xl border bg-white p-5">
              <h2 className="font-semibold">Add person</h2>

              <input name="firstName" placeholder="First name" className="mt-4 w-full rounded-lg border p-3" />
              <input name="lastName" placeholder="Last name" className="mt-3 w-full rounded-lg border p-3" />

              <select name="gender" className="mt-3 w-full rounded-lg border p-3">
                <option value="UNKNOWN">Unknown</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
              </select>

              <label className="mt-3 block text-sm text-slate-600">Birth date</label>
              <input name="birthDate" type="date" className="mt-1 w-full rounded-lg border p-3" />

              <label className="mt-3 flex items-center gap-2 text-sm">
                <input name="isLiving" type="checkbox" defaultChecked />
                Living
              </label>

              <button className="mt-4 rounded-lg bg-emerald-500 px-5 py-3 font-semibold text-white">
                Add Person
              </button>
            </form>

            <form onSubmit={addRelationship} className="rounded-2xl border bg-white p-5">
              <h2 className="font-semibold">Add relationship</h2>

              <select name="fromPersonId" required className="mt-4 w-full rounded-lg border p-3">
                <option value="">From person</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {fullName(person)}
                  </option>
                ))}
              </select>

              <select name="toPersonId" required className="mt-3 w-full rounded-lg border p-3">
                <option value="">To person</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {fullName(person)}
                  </option>
                ))}
              </select>

              <select name="type" className="mt-3 w-full rounded-lg border p-3">
                <option value="PARENT_CHILD">Parent → Child</option>
                <option value="SPOUSE">Spouse</option>
                <option value="PARTNER">Partner</option>
              </select>

              <button className="mt-4 rounded-lg bg-slate-950 px-5 py-3 font-semibold text-white">
                Add Relationship
              </button>
            </form>
          </div>

          <div className="space-y-6">
            <section className="rounded-2xl border bg-white p-5">
              <h2 className="text-xl font-semibold">People</h2>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {people.map((person) => (
                  <div key={person.id} className="rounded-xl border p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-semibold">{fullName(person)}</h3>
                        <p className="text-sm text-slate-500">{person.gender}</p>
                        <p className="text-sm text-slate-500">
                          {person.isLiving ? "Living" : "Deceased"}
                        </p>
                      </div>

                      <button
                        onClick={() => deletePerson(person.id)}
                        className="text-sm font-semibold text-red-600"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border bg-white p-5">
              <h2 className="text-xl font-semibold">Relationships</h2>

              <div className="mt-4 space-y-3">
                {relationships.map((relationship) => {
                  const from = personMap.get(relationship.fromPersonId);
                  const to = personMap.get(relationship.toPersonId);

                  return (
                    <div key={relationship.id} className="flex items-center justify-between rounded-xl border p-4">
                      <div>
                        <p className="font-medium">
                          {from ? fullName(from) : "Unknown"}{" "}
                          <span className="text-slate-500">
                            {relationship.type === "PARENT_CHILD"
                              ? "is parent of"
                              : relationship.type.toLowerCase() + " of"}
                          </span>{" "}
                          {to ? fullName(to) : "Unknown"}
                        </p>
                      </div>

                      <button
                        onClick={() => deleteRelationship(relationship.id)}
                        className="text-sm font-semibold text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}

                {relationships.length === 0 && (
                  <p className="text-slate-500">No relationships added yet.</p>
                )}
              </div>
            </section>

            <section className="rounded-2xl border bg-emerald-50 p-5">
              <h2 className="text-xl font-semibold">Basic visual tree</h2>
              <p className="mt-2 text-sm text-slate-600">
                This MVP includes people and relationship management. The next upgrade can replace this area
                with a drag/zoom interactive tree using React Flow or D3.js.
              </p>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
EOF

cat > "app/trees/[treeId]/page.tsx" <<'EOF'
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { TreeRole } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { hasTreeRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { TreeManager } from "@/components/TreeManager";

type Props = {
  params: Promise<{ treeId: string }>;
};

export default async function TreePage({ params }: Props) {
  const { treeId } = await params;

  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    redirect("/login");
  }

  const canView = await hasTreeRole(session.user.id, treeId, TreeRole.VIEWER);

  if (!canView) {
    redirect("/dashboard");
  }

  const tree = await prisma.familyTree.findUnique({
    where: {
      id: treeId,
    },
  });

  if (!tree) {
    redirect("/dashboard");
  }

  return (
    <main className="min-h-screen bg-slate-100 px-6 py-10">
      <div className="mx-auto max-w-6xl">
        <Link href="/dashboard" className="text-sm font-semibold underline">
          ← Back to dashboard
        </Link>

        <div className="mt-6">
          <TreeManager treeId={tree.id} treeName={tree.name} />
        </div>
      </div>
    </main>
  );
}
EOF

echo "Generating ZIP..."

cd ..

if command -v zip >/dev/null 2>&1; then
  zip -r "${APP}.zip" "$APP" -x "${APP}/node_modules/*" "${APP}/.next/*" "${APP}/.env"
  echo ""
  echo "Done: ${APP}.zip created"
else
  echo "The 'zip' command is not installed."
  echo "Project was created at: ${APP}"
  echo "Install zip, then run:"
  echo "zip -r ${APP}.zip ${APP} -x '${APP}/node_modules/*' '${APP}/.next/*' '${APP}/.env'"
fi
