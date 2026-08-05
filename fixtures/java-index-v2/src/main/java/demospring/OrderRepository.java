package demospring;

import org.springframework.stereotype.Repository;

@Repository
interface OrderRepository {
  Order save(Order order);
}
