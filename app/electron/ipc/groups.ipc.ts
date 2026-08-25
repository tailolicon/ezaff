import { z } from 'zod'
import { getDatabase } from '../db/connection'
import {
  assignProductsToGroup,
  assignProductToGroup,
  createGroup,
  deleteGroup,
  listGroups,
  listGroupsForProduct,
  setProductGroups,
  unassignProductFromGroup,
  updateGroup,
  type Group,
  type GroupWithCount,
} from '../db/repositories/groupRepo'
import { registerHandler } from './registry'

const createSchema = z.object({
  name: z.string().trim().min(1, 'Tên nhóm không được để trống'),
  color: z.string().trim().nullable().optional(),
  sort_order: z.number().int().optional(),
})

const updateSchema = z.object({
  id: z.string().uuid('ID nhóm không hợp lệ'),
  name: z.string().trim().min(1, 'Tên nhóm không được để trống').optional(),
  color: z.string().trim().nullable().optional(),
  sort_order: z.number().int().optional(),
})

const idSchema = z.object({
  id: z.string().uuid('ID nhóm không hợp lệ'),
})

const assignSchema = z.object({
  productId: z.string().uuid('ID sản phẩm không hợp lệ'),
  groupId: z.string().uuid('ID nhóm không hợp lệ'),
})

const productIdSchema = z.object({
  productId: z.string().uuid('ID sản phẩm không hợp lệ'),
})

const setProductGroupsSchema = z.object({
  productId: z.string().uuid('ID sản phẩm không hợp lệ'),
  groupIds: z.array(z.string().uuid('ID nhóm không hợp lệ')),
})

const assignManySchema = z.object({
  productIds: z.array(z.string().uuid('ID sản phẩm không hợp lệ')).min(1),
  groupId: z.string().uuid('ID nhóm không hợp lệ'),
})

export function registerGroupHandlers(): void {
  registerHandler<null, GroupWithCount[]>('groups:list', null, () => {
    return listGroups(getDatabase())
  })

  registerHandler<z.infer<typeof createSchema>, Group>(
    'groups:create',
    createSchema,
    (_event, input) => {
      return createGroup(getDatabase(), input)
    },
  )

  registerHandler<z.infer<typeof updateSchema>, Group>(
    'groups:update',
    updateSchema,
    (_event, input) => {
      return updateGroup(getDatabase(), input)
    },
  )

  registerHandler<z.infer<typeof idSchema>, { deleted: boolean }>(
    'groups:delete',
    idSchema,
    (_event, input) => {
      const deleted = deleteGroup(getDatabase(), input.id)
      if (!deleted) {
        throw new Error('Không tìm thấy nhóm để xoá')
      }
      return { deleted: true }
    },
  )

  registerHandler<z.infer<typeof assignSchema>, { ok: true }>(
    'groups:assign',
    assignSchema,
    (_event, input) => {
      assignProductToGroup(
        getDatabase(),
        input.productId,
        input.groupId,
      )
      return { ok: true }
    },
  )

  registerHandler<z.infer<typeof assignManySchema>, { added: number }>(
    'groups:assignMany',
    assignManySchema,
    (_event, input) => {
      const added = assignProductsToGroup(
        getDatabase(),
        input.productIds,
        input.groupId,
      )
      return { added }
    },
  )

  registerHandler<z.infer<typeof assignSchema>, { removed: boolean }>(
    'groups:unassign',
    assignSchema,
    (_event, input) => {
      const removed = unassignProductFromGroup(
        getDatabase(),
        input.productId,
        input.groupId,
      )
      return { removed }
    },
  )

  registerHandler<z.infer<typeof productIdSchema>, Group[]>(
    'groups:listForProduct',
    productIdSchema,
    (_event, input) => {
      return listGroupsForProduct(getDatabase(), input.productId)
    },
  )

  registerHandler<z.infer<typeof setProductGroupsSchema>, Group[]>(
    'groups:setProductGroups',
    setProductGroupsSchema,
    (_event, input) => {
      return setProductGroups(
        getDatabase(),
        input.productId,
        input.groupIds,
      )
    },
  )
}
