export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELLED'
export type PaymentMethod = 'DIGITAL' | 'CASH'

export interface Payment {
  id: string
  reference: string
  amountCents: number
  currency: 'PEN'
  provider: 'mock' | 'cash' | 'taypi' | 'culqi' | 'mercadopago'
  providerPaymentId?: string
  status: PaymentStatus
  method: PaymentMethod
  createdBy: string
  createdAt: string
  expiresAt?: string
  paidAt?: string
}

export interface SessionUser {
  id: string
  name: string
  email: string
  role: 'ADMIN' | 'CASHIER'
  initials: string
}
