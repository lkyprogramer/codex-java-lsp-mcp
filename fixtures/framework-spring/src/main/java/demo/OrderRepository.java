package demo;

import org.springframework.stereotype.Repository;

@Repository
interface OrderRepository {
  Order save(Order order);
}
