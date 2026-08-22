import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Prisma / pg 는 Next 번들에서 빼고 Node가 node_modules를 그대로 쓰게 한다.
  serverExternalPackages: ['@prisma/client', '.prisma/client', 'pg', '@prisma/adapter-pg'],
}

export default nextConfig
